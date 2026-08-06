/**
 * Billing Reconciliation Cron (FASE 2c/2d)
 *
 * Runs once a day and INDEPENDENTLY re-derives each active subscription's
 * current-period consumption straight from the raw rollups, then compares it
 * against the accumulated agentHoursUsed counter. A divergence means the
 * agent-hours-tracker mis-billed (the historical double-count bug, a dropped
 * range, a corrupted cursor) — so we emit a Sentry warning and surface it on
 * /metrics. This is the safety net that turns "trust the counter" into "verify
 * the counter".
 *
 * It also checks two liveness/integrity signals the tracker cannot self-report:
 *   - tracker_cutoff_stuck:    a sub has rollups older than 24h still unbilled
 *                              (cursor not advancing → tracker wedged).
 *   - invoice_duplicate:       two invoices share (subscriptionId, period) —
 *                              should be impossible under the unique index;
 *                              alerting is defense-in-depth against drift in
 *                              legacy data or a future regression.
 *
 * Why emit Sentry here instead of via the AgentUsageSentryAlerts poller: drift
 * is a point-in-time comparison computed during the run, not an accumulating
 * counter to be sampled. Emitting at computation time is both simpler and
 * correct. Like every alert path, this NEVER throws out of a tick.
 *
 * Runs as a background job gated by leader election (one instance at a time).
 */

import type { Collection, Db } from "mongodb"
import type { Logger } from "pino"
import { captureMessage } from "../lib/sentry.js"
import { waitUntilIdle } from "../lib/drain.js"
import { LEADER_LOCKS, type LeaderElectionService } from "./leader-election.js"
import { toStripeAmount } from "./stripe-api.js"
import type { StripePaymentService } from "./stripe-payment-service.js"

export interface BillingReconciliationCronOptions {
  /** How often to reconcile (default: 24h). */
  intervalMs: number
  /** Leader lock TTL (default: 60s). Refreshed via heartbeat during long runs. */
  leaderLockTtlMs: number
}

export const DEFAULT_RECONCILIATION_OPTS: BillingReconciliationCronOptions = {
  intervalMs: 24 * 60 * 60 * 1000,
  leaderLockTtlMs: 60_000,
}

/** Absolute drift (hours) above which a subscription is flagged. */
export const DRIFT_ABS_HOURS = 0.5
/** Relative drift (fraction of the larger of expected/actual) above which a sub is flagged. */
export const DRIFT_PCT = 0.1
/** Unbilled rollups older than this mean the tracker's cutoff is stuck. */
export const STUCK_LAG_MS = 24 * 60 * 60 * 1000

const HOUR_MS = 3_600_000
/** Window of recent Stripe-charged invoices reconciled against Stripe (60 days). */
export const STRIPE_RECONCILE_WINDOW_MS = 60 * 24 * HOUR_MS

export interface BillingReconciliationMetrics {
  reconciliation_runs: number
  reconciliation_subs_checked: number
  reconciliation_drift_incidents: number
  /** Largest |actual - expected| (hours) seen in the last run. */
  reconciliation_max_drift_hours: number
  /** Active subs whose unbilled rollups have aged past STUCK_LAG_MS (last run). */
  reconciliation_cutoff_stuck_subs: number
  /** Duplicate invoice groups found in the last run. */
  reconciliation_invoice_duplicates: number
  /** Stripe-charged invoices compared against Stripe (last run). */
  reconciliation_stripe_checked: number
  /** Invoices whose Teros vs Stripe paid-state diverged (last run). */
  reconciliation_stripe_drift: number
  /** Invoices auto-healed to paid after a missed webhook (last run). */
  reconciliation_stripe_healed: number
  reconciliation_errors: number
  reconciliation_last_run_at: number | null
  reconciliation_skipped_not_leader: number
}

export class BillingReconciliationCron {
  private timer: NodeJS.Timeout | null = null
  private running = false

  private reconciliation_runs = 0
  private reconciliation_subs_checked = 0
  private reconciliation_drift_incidents = 0
  private reconciliation_max_drift_hours = 0
  private reconciliation_cutoff_stuck_subs = 0
  private reconciliation_invoice_duplicates = 0
  private reconciliation_stripe_checked = 0
  private reconciliation_stripe_drift = 0
  private reconciliation_stripe_healed = 0
  private reconciliation_errors = 0
  private reconciliation_last_run_at: number | null = null
  private reconciliation_skipped_not_leader = 0

  private rollupsCol: Collection<any>
  private billingCol: Collection<any>
  private invoicesCol: Collection<any>

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly leader: LeaderElectionService | null = null,
    private readonly stripe: StripePaymentService | null = null,
    public readonly opts: BillingReconciliationCronOptions = DEFAULT_RECONCILIATION_OPTS,
  ) {
    this.rollupsCol = db.collection("agent_usage_rollups_user_hourly")
    this.billingCol = db.collection("billing_subscriptions")
    this.invoicesCol = db.collection("billing_invoices")
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.log.error({ err }, "billing-reconciliation-cron: tick failed")
      })
    }, this.opts.intervalMs)
    if (typeof this.timer.unref === "function") this.timer.unref()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Graceful shutdown: stop scheduling, wait for an in-flight tick to finish
   * (up to timeoutMs), then release the leader lock. Returns false on timeout.
   */
  async drain(timeoutMs = 10_000): Promise<boolean> {
    this.stop()
    const idle = await waitUntilIdle(() => this.running, { timeoutMs })
    if (idle) await this.leader?.release(LEADER_LOCKS.BillingReconciliation)
    return idle
  }

  getMetrics(): BillingReconciliationMetrics {
    return {
      reconciliation_runs: this.reconciliation_runs,
      reconciliation_subs_checked: this.reconciliation_subs_checked,
      reconciliation_drift_incidents: this.reconciliation_drift_incidents,
      reconciliation_max_drift_hours: this.reconciliation_max_drift_hours,
      reconciliation_cutoff_stuck_subs: this.reconciliation_cutoff_stuck_subs,
      reconciliation_invoice_duplicates: this.reconciliation_invoice_duplicates,
      reconciliation_stripe_checked: this.reconciliation_stripe_checked,
      reconciliation_stripe_drift: this.reconciliation_stripe_drift,
      reconciliation_stripe_healed: this.reconciliation_stripe_healed,
      reconciliation_errors: this.reconciliation_errors,
      reconciliation_last_run_at: this.reconciliation_last_run_at,
      reconciliation_skipped_not_leader: this.reconciliation_skipped_not_leader,
    }
  }

  private static readonly HEARTBEAT_EVERY_MS = 20_000

  private async tick(): Promise<void> {
    if (this.leader) {
      const acquired = await this.leader.tryAcquire(
        LEADER_LOCKS.BillingReconciliation,
        this.opts.leaderLockTtlMs,
      )
      if (!acquired) {
        this.reconciliation_skipped_not_leader++
        return
      }
    }
    const leader = this.leader
    await this.runOnce({
      heartbeat: leader
        ? () => leader.heartbeat(LEADER_LOCKS.BillingReconciliation, this.opts.leaderLockTtlMs)
        : undefined,
    })
  }

  /** Public entry point for tests and manual triggers. */
  async runOnce(opts?: { heartbeat?: () => Promise<boolean>; now?: Date }): Promise<{
    subsChecked: number
    driftIncidents: number
    maxDriftHours: number
    cutoffStuckSubs: number
    invoiceDuplicates: number
    stripeChecked: number
    stripeDrift: number
    stripeHealed: number
  }> {
    if (this.running)
      return {
        subsChecked: 0,
        driftIncidents: 0,
        maxDriftHours: 0,
        cutoffStuckSubs: 0,
        invoiceDuplicates: 0,
        stripeChecked: 0,
        stripeDrift: 0,
        stripeHealed: 0,
      }
    this.running = true
    try {
      const now = opts?.now ?? new Date()
      const result = await this.reconcile(opts?.heartbeat, now)
      const stripeResult = await this.reconcileStripe(now)
      this.reconciliation_runs++
      this.reconciliation_last_run_at = Date.now()
      return { ...result, ...stripeResult }
    } finally {
      this.running = false
    }
  }

  private async reconcile(
    heartbeat: (() => Promise<boolean>) | undefined,
    now: Date,
  ): Promise<{
    subsChecked: number
    driftIncidents: number
    maxDriftHours: number
    cutoffStuckSubs: number
    invoiceDuplicates: number
  }> {
    let subsChecked = 0
    let driftIncidents = 0
    let maxDriftHours = 0
    let cutoffStuckSubs = 0
    const stuckBefore = new Date(now.getTime() - STUCK_LAG_MS)

    const cursor = this.billingCol.find(
      { status: "active" },
      {
        projection: {
          userId: 1,
          planId: 1,
          agentHoursUsed: 1,
          currentPeriodStart: 1,
          periodStartBucket: 1,
          lastBilledHourBucket: 1,
        },
      },
    )

    let lastBeat = Date.now()
    try {
      for await (const sub of cursor) {
        if (heartbeat && Date.now() - lastBeat > BillingReconciliationCron.HEARTBEAT_EVERY_MS) {
          lastBeat = Date.now()
          if (!(await heartbeat())) {
            this.log.warn("billing-reconciliation-cron: lost leadership mid-run, aborting")
            break
          }
        }

        try {
          subsChecked++
          const userId = sub.userId as string
          const periodStart: Date = sub.currentPeriodStart ?? new Date(0)
          // Re-sum from the cursor the tracker actually resumed at this period
          // (TER-627), NOT currentPeriodStart — the reset-cron keeps
          // lastBilledHourBucket across a renewal, so the previous period's
          // unbilled tail lands in agentHoursUsed and would read as spurious drift.
          // Falls back to currentPeriodStart for legacy/new subs.
          const anchor: Date = sub.periodStartBucket ?? periodStart
          const cutoff: Date | null = sub.lastBilledHourBucket ?? null
          const actual = sub.agentHoursUsed ?? 0

          // ── Drift: re-sum what SHOULD be in agentHoursUsed (rollups in this
          //    period, up to the billed cursor) and compare to the counter. ────
          let expected = 0
          if (cutoff) {
            const agg = (await this.rollupsCol
              .aggregate([
                {
                  $match: {
                    "groupKey.userId": userId,
                    hourBucket: { $gt: anchor, $lte: cutoff },
                  },
                },
                { $group: { _id: null, totalMs: { $sum: "$userActiveMs" } } },
              ])
              .toArray()) as Array<{ totalMs: number }>
            expected = (agg[0]?.totalMs ?? 0) / HOUR_MS
          }

          const drift = Math.abs(actual - expected)
          const denom = Math.max(expected, actual)
          const driftPct = denom > 0 ? drift / denom : 0
          if (drift > maxDriftHours) maxDriftHours = drift

          if (drift > DRIFT_ABS_HOURS || driftPct > DRIFT_PCT) {
            driftIncidents++
            this.log.warn(
              { subscriptionId: sub._id, userId, expected, actual, drift, driftPct },
              "billing-reconciliation-cron: agentHoursUsed drift detected",
            )
            captureMessage("billing/reconciliation_drift", "warning", {
              subscriptionId: sub._id,
              userId,
              planId: sub.planId,
              expected,
              actual,
              drift,
              driftPct,
            })
          }

          // ── Cutoff stuck: any rollup beyond the cursor older than 24h means
          //    the tracker stopped advancing for this sub. ────────────────────
          const oldestUnbilled = (await this.rollupsCol
            .aggregate([
              { $match: { "groupKey.userId": userId, hourBucket: { $gt: cutoff ?? new Date(0) } } },
              { $group: { _id: null, oldest: { $min: "$hourBucket" } } },
            ])
            .toArray()) as Array<{ oldest: Date }>
          const oldest = oldestUnbilled[0]?.oldest
          if (oldest && oldest < stuckBefore) {
            cutoffStuckSubs++
            const lagHours = (now.getTime() - oldest.getTime()) / HOUR_MS
            this.log.warn(
              { subscriptionId: sub._id, userId, oldestUnbilled: oldest, lagHours },
              "billing-reconciliation-cron: tracker cutoff stuck",
            )
            captureMessage("billing/tracker_cutoff_stuck", "warning", {
              subscriptionId: sub._id,
              userId,
              oldestUnbilled: oldest,
              lagHours,
            })
          }
        } catch (err) {
          this.reconciliation_errors++
          this.log.error(
            { err, subscriptionId: sub._id, userId: sub.userId },
            "billing-reconciliation-cron: failed to reconcile subscription",
          )
        }
      }
    } finally {
      await cursor.close()
    }

    // ── Invoice duplicates (defense-in-depth vs the unique index) ────────────
    const invoiceDuplicates = await this.countDuplicateInvoices()
    if (invoiceDuplicates > 0) {
      this.log.error(
        { groups: invoiceDuplicates },
        "billing-reconciliation-cron: duplicate invoices detected",
      )
      captureMessage("billing/invoice_duplicate", "error", { groups: invoiceDuplicates })
    }

    this.reconciliation_subs_checked += subsChecked
    this.reconciliation_drift_incidents += driftIncidents
    this.reconciliation_max_drift_hours = maxDriftHours
    this.reconciliation_cutoff_stuck_subs = cutoffStuckSubs
    this.reconciliation_invoice_duplicates = invoiceDuplicates

    return { subsChecked, driftIncidents, maxDriftHours, cutoffStuckSubs, invoiceDuplicates }
  }

  /**
   * Reconcile recent Stripe-charged invoices against Stripe (FASE 4g).
   * Heals a missed webhook (Stripe collected, Teros still pending/overdue → mark
   * paid) and alerts the dangerous divergence (Teros says paid, Stripe doesn't —
   * never auto-changed). No-op when Stripe is not configured.
   */
  private async reconcileStripe(
    now: Date,
  ): Promise<{ stripeChecked: number; stripeDrift: number; stripeHealed: number }> {
    if (!this.stripe?.isEnabled()) {
      this.reconciliation_stripe_checked = 0
      this.reconciliation_stripe_drift = 0
      this.reconciliation_stripe_healed = 0
      return { stripeChecked: 0, stripeDrift: 0, stripeHealed: 0 }
    }

    let stripeChecked = 0
    let stripeDrift = 0
    let stripeHealed = 0
    const windowStart = new Date(now.getTime() - STRIPE_RECONCILE_WINDOW_MS)

    const invoices = (await this.invoicesCol
      .find({
        paymentMethod: "stripe",
        externalReference: { $ne: null },
        updatedAt: { $gte: windowStart },
      })
      .toArray()) as Array<{
      _id: string
      status: string
      amount: number
      externalReference: string
      invoiceNumber?: string | null
      hostedInvoiceUrl?: string | null
      invoicePdfUrl?: string | null
    }>

    for (const inv of invoices) {
      try {
        stripeChecked++
        const stripeInv = await this.stripe.getStripeInvoice(inv.externalReference)
        const stripePaid = stripeInv.paid || stripeInv.status === "paid"
        const terosPaid = inv.status === "paid"

        if (
          stripePaid &&
          !terosPaid &&
          (inv.status === "pending" || inv.status === "overdue" || inv.status === "uncollectible")
        ) {
          // Missed webhook: Stripe collected but Teros didn't record it → heal.
          // `uncollectible` is INCLUDED (TER-624): it's the state that blocks the
          // account, so a user who paid via the hosted page after dunning gave up
          // would otherwise stay blocked forever if the invoice.paid webhook is lost.
          await this.invoicesCol.updateOne(
            { _id: inv._id },
            {
              $set: {
                status: "paid",
                invoiceNumber: stripeInv.number ?? inv.invoiceNumber ?? null,
                hostedInvoiceUrl: stripeInv.hosted_invoice_url ?? inv.hostedInvoiceUrl ?? null,
                invoicePdfUrl: stripeInv.invoice_pdf ?? inv.invoicePdfUrl ?? null,
                nextAttemptAt: null,
                lastChargeError: null,
                updatedAt: now,
              },
            },
          )
          stripeHealed++
          stripeDrift++
          captureMessage("billing/stripe_drift", "warning", {
            invoiceId: inv._id,
            kind: "healed_missed_webhook",
            stripeInvoiceId: inv.externalReference,
          })
        } else if (terosPaid && !stripePaid) {
          // Teros recorded a payment Stripe didn't make — never auto-change; alert.
          stripeDrift++
          captureMessage("billing/stripe_drift", "error", {
            invoiceId: inv._id,
            kind: "teros_paid_stripe_unpaid",
            stripeStatus: stripeInv.status,
            stripeInvoiceId: inv.externalReference,
          })
        }

        // Amount reconciliation (independent of paid-state healing): whenever Stripe
        // collected, what it charged the card MUST equal the quote. The charge guard
        // makes this hold going forward; this is the defense-in-depth net that would
        // have surfaced the €43→€145 incident the next day (before there was a guard).
        if (stripePaid) {
          const expected = toStripeAmount(inv.amount)
          if (stripeInv.amount_paid !== expected) {
            stripeDrift++
            captureMessage("billing/amount_mismatch", "error", {
              invoiceId: inv._id,
              expected,
              charged: stripeInv.amount_paid,
              stripeInvoiceId: inv.externalReference,
            })
          }
        }
      } catch (err) {
        this.reconciliation_errors++
        this.log.error(
          { err, invoiceId: inv._id },
          "billing-reconciliation-cron: stripe reconcile failed",
        )
      }
    }

    this.reconciliation_stripe_checked = stripeChecked
    this.reconciliation_stripe_drift = stripeDrift
    this.reconciliation_stripe_healed = stripeHealed
    return { stripeChecked, stripeDrift, stripeHealed }
  }

  /**
   * Count SUBSCRIPTION invoice groups sharing (subscriptionId, periodStart,
   * periodEnd). Boost invoices (kind:'boost') legitimately share a period with
   * the subscription invoice and with each other, so they are excluded — else a
   * boost purchase would raise a false invoice_duplicate alert (TER-596 I1).
   */
  private async countDuplicateInvoices(): Promise<number> {
    const groups = (await this.invoicesCol
      .aggregate([
        { $match: { kind: { $ne: "boost" } } },
        {
          $group: {
            _id: { s: "$subscriptionId", ps: "$periodStart", pe: "$periodEnd" },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
        { $count: "groups" },
      ])
      .toArray()) as Array<{ groups: number }>
    return groups[0]?.groups ?? 0
  }
}
