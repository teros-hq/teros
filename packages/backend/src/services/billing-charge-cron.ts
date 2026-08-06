/**
 * Billing Charge Cron (FASE 4c/4d).
 *
 * Charges the invoices the reset-cron generates. Model B keeps Teros as the
 * source of truth: the reset-cron writes a `pending` billing_invoices row at
 * period close; THIS cron hands it to Stripe (one Stripe Invoice per Teros
 * invoice → legal numbering + PDF + tax) and tracks the dunning lifecycle.
 *
 * Separated from the reset-cron on purpose: network calls (and their failures)
 * stay out of the period-rewrite path, and the retry/grace loop lives in one
 * place. Leader-gated so only one instance charges at a time; idempotency keys
 * inside chargeInvoice make a double-charge impossible even if a tick overlaps.
 *
 * Dunning (decisions B/C): a failed charge → 'overdue', retried on a backoff
 * schedule until the grace window (default 7 days from the invoice date) expires;
 * then the invoice is marked 'uncollectible'. We do NOT downgrade the plan
 * (decision B) — the tier is preserved so paying restores access. The block is
 * enforced transversally at the provider choke point (assertAccountNotBlocked),
 * which cuts EVERY provider (incl. BYOK) while a blocking invoice exists. A
 * `config`-category failure (our Stripe key is broken) is NOT dunned against the
 * user — it's surfaced and left for ops.
 */

import type { Collection, Db } from 'mongodb'
import type { Logger } from 'pino'
import { captureException, captureMessage } from '../lib/sentry.js'
import {
  getBillingInvoicesCollection,
  type BillingInvoice,
} from '../models/billing.js'
import { waitUntilIdle } from '../lib/drain.js'
import { LEADER_LOCKS, type LeaderElectionService } from './leader-election.js'
import type { ChargeResult, StripePaymentService } from './stripe-payment-service.js'

export interface BillingChargeCronOptions {
  /** How often to scan for chargeable invoices (default: 5 min). */
  intervalMs: number
  /** Leader lock TTL (default: 60s). */
  leaderLockTtlMs: number
  /** Days from the invoice date before an unpaid invoice blocks the account (decisions B/C). */
  graceDays: number
}

export const DEFAULT_CHARGE_OPTS: BillingChargeCronOptions = {
  intervalMs: 5 * 60 * 1000,
  leaderLockTtlMs: 60_000,
  graceDays: 7,
}

/**
 * Backoff schedule (hours) between dunning retries, indexed by prior attempt
 * count. Past the end, the last value repeats — but the grace window is the real
 * stop condition. ~1h, 6h, 24h, 72h.
 */
export const RETRY_BACKOFF_HOURS = [1, 6, 24, 72]

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

export interface BillingChargeMetrics {
  charge_runs: number
  charge_attempts: number
  charge_succeeded: number
  charge_failed: number
  charge_waived: number
  charge_blocked: number
  charge_config_errors: number
  /** Invoices the charge guard refused (amount would diverge from the quote). */
  charge_integrity_holds: number
  charge_errors: number
  charge_last_run_at: number | null
  charge_skipped_not_leader: number
}

export class BillingChargeCron {
  private timer: NodeJS.Timeout | null = null
  private running = false

  private charge_runs = 0
  private charge_attempts = 0
  private charge_succeeded = 0
  private charge_failed = 0
  private charge_waived = 0
  private charge_blocked = 0
  private charge_config_errors = 0
  private charge_integrity_holds = 0
  private charge_errors = 0
  private charge_last_run_at: number | null = null
  private charge_skipped_not_leader = 0

  private invoicesCol: Collection<BillingInvoice>

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly stripe: StripePaymentService,
    private readonly leader: LeaderElectionService | null = null,
    public readonly opts: BillingChargeCronOptions = DEFAULT_CHARGE_OPTS,
  ) {
    this.invoicesCol = getBillingInvoicesCollection(db)
  }

  start(): void {
    if (this.timer !== null) return
    // No-op when Stripe is not configured — nothing to charge.
    if (!this.stripe.isEnabled()) {
      this.log.info('billing-charge-cron: Stripe not configured, cron disabled')
      return
    }
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.log.error({ err }, 'billing-charge-cron: tick failed')
      })
    }, this.opts.intervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
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
    if (idle) await this.leader?.release(LEADER_LOCKS.BillingChargeCron)
    return idle
  }

  getMetrics(): BillingChargeMetrics {
    return {
      charge_runs: this.charge_runs,
      charge_attempts: this.charge_attempts,
      charge_succeeded: this.charge_succeeded,
      charge_failed: this.charge_failed,
      charge_waived: this.charge_waived,
      charge_blocked: this.charge_blocked,
      charge_config_errors: this.charge_config_errors,
      charge_integrity_holds: this.charge_integrity_holds,
      charge_errors: this.charge_errors,
      charge_last_run_at: this.charge_last_run_at,
      charge_skipped_not_leader: this.charge_skipped_not_leader,
    }
  }

  /** Public entry point for tests and manual triggers. */
  async runOnce(): Promise<{ charged: number; failed: number; blocked: number }> {
    if (this.running) return { charged: 0, failed: 0, blocked: 0 }
    if (!this.stripe.isEnabled()) return { charged: 0, failed: 0, blocked: 0 }
    this.running = true
    try {
      const result = await this.processChargeableInvoices()
      this.charge_runs++
      this.charge_last_run_at = Date.now()
      return result
    } finally {
      this.running = false
    }
  }

  private async tick(): Promise<void> {
    if (this.leader) {
      const acquired = await this.leader.tryAcquire(
        LEADER_LOCKS.BillingChargeCron,
        this.opts.leaderLockTtlMs,
      )
      if (!acquired) {
        this.charge_skipped_not_leader++
        return
      }
    }
    await this.runOnce()
  }

  private async processChargeableInvoices(): Promise<{
    charged: number
    failed: number
    blocked: number
  }> {
    const now = new Date()
    let charged = 0
    let failed = 0
    let blocked = 0

    // pending = never charged; overdue = in dunning. Only those whose retry time
    // has arrived (nextAttemptAt absent or due).
    const invoices = await this.invoicesCol
      .find({
        status: { $in: ['pending', 'overdue'] },
        paymentMethod: 'stripe',
        $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }],
      })
      .toArray()

    for (const invoice of invoices) {
      try {
        // €0 (BETA / waived) — nothing to charge.
        if (invoice.amount <= 0) {
          await this.invoicesCol.updateOne(
            { _id: invoice._id },
            { $set: { status: 'waived', updatedAt: now } },
          )
          this.charge_waived++
          continue
        }

        const attempt = (invoice.attemptCount ?? 0) + 1
        this.charge_attempts++
        const result = await this.stripe.chargeInvoice(
          {
            _id: invoice._id,
            userId: invoice.userId,
            amount: invoice.amount,
            currency: invoice.currency,
            externalReference: invoice.externalReference,
            description: this.describe(invoice),
          },
          attempt,
        )

        if (result.status === 'paid') {
          await this.invoicesCol.updateOne(
            { _id: invoice._id },
            {
              $set: {
                status: 'paid',
                // Reconcile what Stripe actually collected (guard guarantees == amount).
                amountCharged: result.amountPaid ?? invoice.amount,
                externalReference: result.stripeInvoiceId ?? invoice.externalReference,
                invoiceNumber: result.invoiceNumber ?? invoice.invoiceNumber,
                hostedInvoiceUrl: result.hostedInvoiceUrl ?? null,
                invoicePdfUrl: result.invoicePdfUrl ?? null,
                attemptCount: attempt,
                lastAttemptAt: now,
                nextAttemptAt: null,
                lastChargeError: null,
                updatedAt: now,
              },
            },
          )
          this.charge_succeeded++
          charged++
          this.log.info(
            { invoiceId: invoice._id, userId: invoice.userId, attempt },
            'billing-charge-cron: invoice charged',
          )
          continue
        }

        // ── Failure → dunning (4d) ────────────────────────────────────────────
        this.charge_failed++
        failed++
        const issue = result.issue
        if (issue?.category === 'integrity') {
          // The charge guard refused it: the card total would diverge from the quote
          // (a swept customer balance / unexpected tax). NOT the user's fault — the
          // invoice was voided (no charge landed). HOLD it: no dunning, no account
          // block. status:'held' drops it from the chargeable query, so it will not
          // retry every tick; ops remediates the balance and re-opens it (status →
          // pending) deliberately. CLEAR externalReference: it points at the VOIDED
          // Stripe invoice, so leaving it would make the re-charge reuse a dead
          // invoice (retrieve → void → re-held, forever); nulling it forces a fresh
          // Stripe invoice on the next attempt. The void id stays in the Sentry alert.
          this.charge_integrity_holds++
          captureMessage('billing/amount_mismatch', 'error', {
            invoiceId: invoice._id,
            userId: invoice.userId,
            code: issue.code,
            message: issue.message,
            voidedStripeInvoiceId: result.stripeInvoiceId ?? invoice.externalReference,
          })
          await this.invoicesCol.updateOne(
            { _id: invoice._id },
            {
              $set: {
                status: 'held',
                externalReference: null,
                lastChargeError: issue.code,
                lastAttemptAt: now,
                updatedAt: now,
              },
            },
          )
          continue
        }
        if (issue?.category === 'config') {
          // Our Stripe is broken — do NOT dun the user. Surface and move on.
          this.charge_config_errors++
          captureMessage('billing/stripe_config_error', 'error', {
            invoiceId: invoice._id,
            code: issue.code,
            message: issue.message,
          })
          await this.invoicesCol.updateOne(
            { _id: invoice._id },
            {
              $set: {
                // Keep any Stripe invoice id a partial attempt produced (TER-622),
                // so a later retry reuses it instead of minting a second invoice.
                externalReference: result.stripeInvoiceId ?? invoice.externalReference,
                lastChargeError: issue.code,
                lastAttemptAt: now,
                updatedAt: now,
              },
            },
          )
          continue
        }

        const didBlock = await this.recordFailureAndMaybeBlock(invoice, attempt, result, now)
        if (didBlock) {
          blocked++
          this.charge_blocked++
        }
      } catch (err) {
        this.charge_errors++
        this.log.error(
          { err, invoiceId: invoice._id, userId: invoice.userId },
          'billing-charge-cron: failed to process invoice',
        )
        // Report per-invoice charge failures (nota 21): isolated per item, so
        // without this an unexpected charge crash is invisible in prod.
        captureException(
          err,
          { scope: 'billing/charge_invoice', invoiceId: invoice._id, userId: invoice.userId },
          { userId: invoice.userId },
        )
      }
    }

    return { charged, failed, blocked }
  }

  /**
   * Record a failed charge and, if the grace window has expired, mark the
   * invoice 'uncollectible'. Returns true when grace was exhausted (the account
   * is now blocked transversally by the provider gate). We do NOT downgrade the
   * plan (decision B): the tier is preserved so paying restores access.
   */
  private async recordFailureAndMaybeBlock(
    invoice: BillingInvoice,
    attempt: number,
    result: ChargeResult,
    now: Date,
  ): Promise<boolean> {
    const issue = result.issue
    // Persist the Stripe invoice id even on FAILURE (TER-622): chargeInvoice
    // creates + finalizes the Stripe Invoice before payInvoice, and returns its id
    // in the failed result too. Dropping it left the row with externalReference=null
    // → the next dunning retry past Stripe's ~24h idempotency window re-creates a
    // SECOND Stripe Invoice (double legal number, and a double charge if the first
    // pay actually succeeded but its response was lost). Keeping it makes every
    // retry reuse the same invoice and lets reconcileStripe heal it.
    const stripeRefs = {
      externalReference: result.stripeInvoiceId ?? invoice.externalReference,
      invoiceNumber: result.invoiceNumber ?? invoice.invoiceNumber,
      hostedInvoiceUrl: result.hostedInvoiceUrl ?? invoice.hostedInvoiceUrl ?? null,
      invoicePdfUrl: result.invoicePdfUrl ?? invoice.invoicePdfUrl ?? null,
    }

    // Grace anchors on the FIRST failure: invoice.createdAt + graceDays.
    const graceEnd =
      invoice.gracePeriodEndsAt ??
      new Date(invoice.createdAt.getTime() + this.opts.graceDays * DAY_MS)

    if (now.getTime() >= graceEnd.getTime()) {
      // Grace exhausted — give up collecting and mark the invoice uncollectible.
      // The plan is KEPT (decision B): the account is blocked transversally by the
      // provider gate (assertAccountNotBlocked), and paying the invoice lifts the
      // block without a re-upgrade.
      await this.invoicesCol.updateOne(
        { _id: invoice._id },
        {
          $set: {
            status: 'uncollectible',
            ...stripeRefs,
            attemptCount: attempt,
            lastAttemptAt: now,
            lastChargeError: issue?.code ?? 'UNKNOWN',
            gracePeriodEndsAt: graceEnd,
            updatedAt: now,
          },
        },
      )
      this.log.warn(
        { invoiceId: invoice._id, userId: invoice.userId, subscriptionId: invoice.subscriptionId },
        'billing-charge-cron: grace exhausted, invoice uncollectible (account blocked, plan kept)',
      )
      return true
    }

    // Still in grace — schedule the next retry on the backoff curve.
    const backoffHours =
      RETRY_BACKOFF_HOURS[Math.min(attempt - 1, RETRY_BACKOFF_HOURS.length - 1)]
    const nextAttemptAt = new Date(now.getTime() + backoffHours * HOUR_MS)
    await this.invoicesCol.updateOne(
      { _id: invoice._id },
      {
        $set: {
          status: 'overdue',
          ...stripeRefs,
          attemptCount: attempt,
          lastAttemptAt: now,
          nextAttemptAt,
          gracePeriodEndsAt: graceEnd,
          lastChargeError: issue?.code ?? 'UNKNOWN',
          updatedAt: now,
        },
      },
    )
    return false
  }

  private describe(invoice: BillingInvoice): string {
    const fmt = (d: Date) => d.toISOString().slice(0, 10)
    return `Teros subscription — ${fmt(invoice.periodStart)} to ${fmt(invoice.periodEnd)}`
  }
}
