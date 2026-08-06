/**
 * Billing Reset Cron
 *
 * Scans billing_subscriptions every 5 minutes and resets
 * agentHoursUsed + overageHours for any subscription whose
 * currentPeriodEnd has passed.
 *
 * Also advances currentPeriodStart / currentPeriodEnd by one
 * month and clears lastBilledHourBucket so the tracker starts
 * fresh for the new cycle.
 *
 * Idempotent: a subscription is only reset when currentPeriodEnd
 * is strictly in the past, so replays and retries are safe.
 *
 * Runs as a background job gated by leader election.
 *
 *
 */

import type { Collection, Db } from "mongodb"
import type { Logger } from "pino"
import { isMongoDuplicateKey } from "../lib/mongo-errors.js"
import { captureException } from "../lib/sentry.js"
import { waitUntilIdle } from "../lib/drain.js"
import { LEADER_LOCKS, type LeaderElectionService } from "./leader-election.js"
import {
  addDaysUTC,
  addMonthsClampDay,
  getActiveBoostHours,
  getBillingHourBoostsCollection,
  getEffectiveLimit,
  getEffectivePrice,
  getBillingInvoicesCollection,
  getBillingPeriodSnapshotsCollection,
  getBillingPlansCollection,
  STARTER_PLAN_ID,
  type BillingInvoice,
  type BillingPeriodSnapshot,
} from "../models/billing.js"

export interface BillingResetCronOptions {
  /** How often to check for expired billing periods (default: 5 min). */
  intervalMs: number
  /** Leader lock TTL (default: 60s). */
  leaderLockTtlMs: number
}

export const DEFAULT_RESET_OPTS: BillingResetCronOptions = {
  intervalMs: 5 * 60 * 1000,
  leaderLockTtlMs: 60_000,
}

/**
 * A subscription claimed for reset (`resetting: true`) older than this is
 * considered abandoned by a crashed run and is re-claimed. Bounds how long a
 * crash mid-reset can keep the agent-hours-tracker from billing that sub.
 */
export const RESETTING_STALE_MS = 5 * 60 * 1000

export interface BillingResetCronMetrics {
  reset_runs: number
  reset_subscriptions: number
  reset_snapshots: number
  reset_errors: number
  reset_last_run_at: number | null
  reset_skipped_not_leader: number
}

export class BillingResetCron {
  private timer: NodeJS.Timeout | null = null
  private running = false

  // Metrics
  private reset_runs = 0
  private reset_subscriptions = 0
  private reset_snapshots = 0
  private reset_errors = 0
  private reset_last_run_at: number | null = null
  private reset_skipped_not_leader = 0

  private billingCol: Collection<any>
  private invoicesCol: Collection<BillingInvoice>
  private snapshotsCol: Collection<BillingPeriodSnapshot>

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly leader: LeaderElectionService | null = null,
    public readonly opts: BillingResetCronOptions = DEFAULT_RESET_OPTS,
  ) {
    this.billingCol = db.collection("billing_subscriptions")
    this.invoicesCol = getBillingInvoicesCollection(db)
    this.snapshotsCol = getBillingPeriodSnapshotsCollection(db)
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.log.error({ err }, "billing-reset-cron: tick failed")
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
    if (idle) await this.leader?.release(LEADER_LOCKS.BillingResetCron)
    return idle
  }

  getMetrics(): BillingResetCronMetrics {
    return {
      reset_runs: this.reset_runs,
      reset_subscriptions: this.reset_subscriptions,
      reset_snapshots: this.reset_snapshots,
      reset_errors: this.reset_errors,
      reset_last_run_at: this.reset_last_run_at,
      reset_skipped_not_leader: this.reset_skipped_not_leader,
    }
  }

  /** Public entry point for tests and manual triggers. */
  async runOnce(): Promise<{ subscriptionsReset: number }> {
    if (this.running) return { subscriptionsReset: 0 }
    this.running = true
    try {
      const result = await this.processExpiredSubscriptions()
      this.reset_runs++
      this.reset_last_run_at = Date.now()
      return result
    } finally {
      this.running = false
    }
  }

  private async tick(): Promise<void> {
    if (this.leader) {
      const acquired = await this.leader.tryAcquire(
        LEADER_LOCKS.BillingResetCron,
        this.opts.leaderLockTtlMs,
      )
      if (!acquired) {
        this.reset_skipped_not_leader++
        return
      }
    }
    await this.runOnce()
  }

  private async processExpiredSubscriptions(): Promise<{
    subscriptionsReset: number
  }> {
    let subscriptionsReset = 0
    const now = new Date()
    const staleBefore = new Date(now.getTime() - RESETTING_STALE_MS)

    // Reset individual subscriptions
    const cursor = this.billingCol.find({
      status: "active",
      currentPeriodEnd: { $lt: now },
    })

    try {
      for await (const found of cursor) {
        try {
          // ── Claim the sub atomically (mutual exclusion with the tracker) ───
          // findOneAndUpdate is single-document atomic on standalone Mongo (no
          // transaction needed). We flip resetting:true so the agent-hours
          // tracker skips this sub while we rewrite its period, and we re-claim
          // any sub left resetting by a crashed run (resettingAt older than the
          // stale window). The cursor snapshot may be stale, so we operate on
          // the document RETURNED by the claim.
          const claim = await this.billingCol.findOneAndUpdate(
            {
              _id: found._id,
              status: "active",
              currentPeriodEnd: { $lt: now },
              $or: [
                { resetting: { $ne: true } },
                { resettingAt: { $lt: staleBefore } },
              ],
            },
            { $set: { resetting: true, resettingAt: now } },
            { returnDocument: "after" },
          )
          // Another worker claimed it, or it was already reset between the
          // cursor read and now — skip.
          if (!claim) continue
          const sub = claim

          const nextPeriodStart = sub.currentPeriodEnd
          const nextPeriodEnd = addMonthsClampDay(nextPeriodStart, 1)

          // ── Create invoice for the period that just ended ──────────────────
          const plan = await getBillingPlansCollection(this.db).findOne({
            _id: sub.planId,
          })
          const amount = plan
            ? getEffectivePrice(sub, plan)
            : sub.customPrice ?? 0

          // Idempotent upsert keyed by (subscriptionId, periodStart, periodEnd).
          // The unique index billing_inv_period_unique guarantees a single
          // invoice per period even if the cron re-runs or crashes mid-cycle
          // (invoice written, subscription not yet reset). The equality filter
          // supplies those 3 fields on insert; $setOnInsert supplies the rest.
          const invoiceFields: Omit<
            BillingInvoice,
            "_id" | "subscriptionId" | "periodStart" | "periodEnd"
          > = {
            userId: sub.userId,
            amount,
            currency: plan?.currency ?? "EUR",
            status: "pending",
            paymentMethod: sub.paymentMethod ?? "manual",
            invoiceNumber: null,
            externalReference: null,
            notes: `Auto-generated on period reset. Effective price: ${amount} ${plan?.currency ?? "EUR"}.`,
            createdAt: now,
            updatedAt: now,
          }

          // kind:'subscription' in the FILTER scopes the upsert to the period
          // invoice only — a boost invoice shares (subscriptionId, period) but is
          // kind:'boost', so it must NOT satisfy this match (else the cron would
          // think the period was already billed). The equality also stamps
          // kind:'subscription' on the inserted doc (so it's covered by the
          // partial billing_inv_period_unique index). TER-596 I1.
          const invoiceResult = await this.invoicesCol.updateOne(
            {
              subscriptionId: sub._id,
              periodStart: sub.currentPeriodStart,
              periodEnd: sub.currentPeriodEnd,
              kind: "subscription",
            },
            { $setOnInsert: { _id: crypto.randomUUID(), ...invoiceFields } },
            { upsert: true },
          )

          if (invoiceResult.upsertedCount > 0) {
            this.log.info(
              {
                subscriptionId: sub._id,
                userId: sub.userId,
                amount,
                periodStart: sub.currentPeriodStart,
                periodEnd: sub.currentPeriodEnd,
              },
              "billing-reset-cron: invoice created for ended period",
            )
          } else {
            this.log.warn(
              { subscriptionId: sub._id, userId: sub.userId },
              "billing-reset-cron: invoice already existed for period (idempotent skip)",
            )
          }

          // ── Period snapshot (FASE 2b) ──────────────────────────────────────
          // Capture the closing period's consumption + limit BEFORE we zero
          // agentHoursUsed below, so a past period stays explainable after the
          // live counter resets. Keyed by the same (subscriptionId, period) as
          // the invoice → the unique index makes a re-run idempotent. Resolve
          // the invoiceId from the upsert (new) or a lookup (pre-existing).
          let invoiceId: string | null =
            (invoiceResult.upsertedId as unknown as string) ?? null
          if (!invoiceId) {
            const existingInvoice = await this.invoicesCol.findOne(
              {
                subscriptionId: sub._id,
                periodStart: sub.currentPeriodStart,
                periodEnd: sub.currentPeriodEnd,
                kind: "subscription",
              },
              { projection: { _id: 1 } },
            )
            invoiceId = existingInvoice?._id ?? null
          }
          // Capture the limit that was actually in force this period, including
          // any boosts granted for it (decision #10), so a boosted period stays
          // explainable after the boosts expire below. Use the period start as
          // the reference instant — it always falls inside the closing window.
          const closingBoostHours = await getActiveBoostHours(
            this.db,
            sub._id,
            sub.currentPeriodStart,
          )
          const agentHoursLimit = plan
            ? getEffectiveLimit(sub, plan, closingBoostHours)
            : (sub.customAgentHoursLimit ?? 0) + closingBoostHours
          try {
            await this.snapshotsCol.insertOne({
              _id: crypto.randomUUID(),
              subscriptionId: sub._id,
              userId: sub.userId,
              planId: sub.planId,
              periodStart: sub.currentPeriodStart,
              periodEnd: sub.currentPeriodEnd,
              agentHoursUsed: sub.agentHoursUsed ?? 0,
              agentHoursLimit,
              overageHours: sub.overageHours ?? 0,
              invoiceId,
              createdAt: now,
            })
            this.reset_snapshots++
          } catch (err) {
            if (!isMongoDuplicateKey(err)) throw err
            // Snapshot already taken for this period (idempotent re-run) — skip.
          }

          // Expire this period's boosts so they never leak into the next cycle
          // (decision #10). Idempotent: a re-run finds no remaining 'active'
          // boosts for the closed window. getActiveBoostHours also guards by the
          // period window, so correctness does not depend on this sweep — it
          // keeps the active set small and the audit trail truthful.
          await getBillingHourBoostsCollection(this.db).updateMany(
            {
              subscriptionId: sub._id,
              status: "active",
              periodEnd: { $lte: sub.currentPeriodEnd },
            },
            { $set: { status: "expired" } },
          )

          if (sub.cancelAtPeriodEnd) {
            // Deferred cancellation matured (decision #7): the paid period is
            // over, so close this sub and open a fresh Starter sub anchored to
            // day+1. Close FIRST so the partial unique index never sees two
            // active subs for this user.
            await this.billingCol.updateOne(
              { _id: sub._id },
              {
                $set: {
                  status: "ended",
                  endDate: now,
                  cancelAtPeriodEnd: false,
                  resetting: false,
                  updatedAt: now,
                },
              },
            )
            const starterStart = addDaysUTC(now, 1)
            await this.billingCol.insertOne({
              _id: crypto.randomUUID(),
              userId: sub.userId,
              planId: STARTER_PLAN_ID,
              customAgentHoursLimit: null,
              customPrice: null,
              customPriceNote: null,
              agentHoursUsed: 0,
              overageHours: 0,
              // Fresh cursor: don't bill pre-cancellation hours onto the starter.
              lastBilledHourBucket: now,
              currentPeriodStart: starterStart,
              currentPeriodEnd: addMonthsClampDay(starterStart, 1),
              status: "active",
              startDate: now,
              endDate: null,
              paymentMethod: "manual",
              billingNotes: "Auto-created on cancellation (period completed)",
              terosProviderConfigId: null,
              teamId: null,
              createdAt: now,
              updatedAt: now,
            })
          } else if (sub.scheduledPlanChange) {
            // Deferred downgrade matured (decision D): the paid period on the
            // previous (more expensive) plan is over, so close this sub and open
            // the scheduled cheaper plan anchored to day+1. Mirrors the
            // cancelAtPeriodEnd branch; inherits account-level fields. Close
            // FIRST so the partial unique index never sees two active subs.
            const target = sub.scheduledPlanChange
            await this.billingCol.updateOne(
              { _id: sub._id },
              {
                $set: {
                  status: "ended",
                  endDate: now,
                  scheduledPlanChange: null,
                  resetting: false,
                  updatedAt: now,
                },
              },
            )
            const downStart = addDaysUTC(now, 1)
            await this.billingCol.insertOne({
              _id: crypto.randomUUID(),
              userId: sub.userId,
              planId: target.planId,
              customAgentHoursLimit: null,
              customPrice: null,
              customPriceNote: null,
              agentHoursUsed: 0,
              overageHours: 0,
              // Fresh cursor: don't bill pre-downgrade hours onto the new plan.
              lastBilledHourBucket: now,
              // Reconcile this period from the fresh cursor, not currentPeriodStart
              // (which is now+1 day here) — keeps the drift check aligned (TER-627).
              periodStartBucket: now,
              currentPeriodStart: downStart,
              currentPeriodEnd: addMonthsClampDay(downStart, 1),
              status: "active",
              startDate: now,
              endDate: null,
              paymentMethod: sub.paymentMethod ?? "manual",
              billingNotes: `Auto-created on scheduled downgrade to ${target.planId}`,
              terosProviderConfigId: sub.terosProviderConfigId ?? null,
              teamId: sub.teamId ?? null,
              createdAt: now,
              updatedAt: now,
            })
          } else {
            // Normal renewal: zero the period's usage, advance the window,
            // release the reset claim. We deliberately KEEP lastBilledHourBucket
            // — it is a monotonic high-water mark of buckets already billed, NOT
            // per-period state. Unsetting it would send the tracker's cutoff back
            // to epoch, re-summing up to 2 years of TTL-retained rollups into the
            // new period (the historical double-count the FASE 0 reset still had).
            await this.billingCol.updateOne(
              { _id: sub._id },
              {
                $set: {
                  agentHoursUsed: 0,
                  overageHours: 0,
                  currentPeriodStart: nextPeriodStart,
                  currentPeriodEnd: nextPeriodEnd,
                  // Anchor the new period's reconciliation at the cursor we KEEP
                  // (not currentPeriodStart): the tracker resumes accumulating from
                  // here, so reconcile must re-sum from here too or the previous
                  // period's unbilled tail reads as spurious drift (TER-627).
                  periodStartBucket: sub.lastBilledHourBucket ?? nextPeriodStart,
                  resetting: false,
                  // New period: re-arm the 80% usage warning (decision #11).
                  warned80At: null,
                  updatedAt: now,
                },
              },
            )
          }

          subscriptionsReset++
          this.reset_subscriptions++
          this.log.info(
            {
              subscriptionId: sub._id,
              userId: sub.userId,
              previousPeriodEnd: sub.currentPeriodEnd,
              nextPeriodStart,
              nextPeriodEnd,
            },
            "billing-reset-cron: subscription reset",
          )
        } catch (err) {
          this.reset_errors++
          this.log.error(
            { err, subscriptionId: found._id, userId: found.userId },
            "billing-reset-cron: failed to reset subscription",
          )
          // Report per-sub reset failures (nota 21): isolated per item, otherwise
          // invisible in prod (a stuck reset means a period never renews/invoices).
          captureException(
            err,
            { scope: "billing/reset_subscription", subscriptionId: found._id, userId: found.userId },
            { userId: found.userId },
          )
        }
      }
    } finally {
      await cursor.close()
    }

    return { subscriptionsReset }
  }
}
