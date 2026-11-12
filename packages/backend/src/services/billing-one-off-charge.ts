/**
 * chargeOneOffInvoice — the shared "charge BEFORE grant" primitive for one-off
 * Stripe charges (TER-619).
 *
 * Extracted from billing.purchase-boost so the self-serve plan upgrade
 * (billing.change-plan) charges money through the EXACT same path instead of a
 * divergent copy. The divergence was the bug: purchase-boost charged the card
 * immediately via Stripe Invoices and only granted on success, while change-plan
 * granted first and "charged" via a best-effort customer-balance transaction that
 * silently no-op'd (no card → no charge; with card → a deferred balance, never an
 * immediate charge). Both now route through here — the asymmetry can't recur.
 *
 * Contract (mirrors chargeInvoice, so callers stay declarative):
 *   - `status: 'failed'` with the classified issue when there is no vaulted card
 *     (NO_PAYMENT_METHOD) or Stripe declines — the caller grants NOTHING.
 *   - `status: 'paid'` with the persisted billing_invoices row otherwise.
 *
 * Idempotency / crash-safety (money moves, so this is the whole point): the
 * caller passes a STABLE `invoiceId` (derived from a per-attempt reqId). The
 * Stripe idempotency keys inside chargeInvoice derive from that id, so a replay
 * reuses the same Stripe invoice and never double-charges. A local row is
 * written BEFORE charging (status 'held') and, when the charge fails, it keeps
 * the Stripe invoice id the attempt produced (BIL-5: it used to be dropped,
 * leaving finalized Stripe invoices — legal number consumed — with no Teros
 * row, invisible to reconciliation). A retry rereads it and passes it back as
 * `externalReference`, so the charge REUSES that invoice even past Stripe's
 * ~24h idempotency-key expiry. 'held' keeps the row out of the charge-cron
 * (which would otherwise collect it without the grant) and does not block the
 * account.
 */

import type { Db } from 'mongodb'
import { captureMessage } from '../lib/sentry.js'
import { type BillingInvoice, getBillingInvoicesCollection } from '../models/billing.js'
import { NO_PAYMENT_METHOD, type StripeIssue } from './_stripe-error.js'
import type { ChargeableInvoice, StripePaymentService } from './stripe-payment-service.js'

export interface OneOffChargeParams {
  userId: string
  /**
   * Stable idempotency anchor AND the persisted billing_invoices `_id` (e.g.
   * `plan-change:<userId>:<reqId>` or `boost-purchase:<userId>:<reqId>`).
   */
  invoiceId: string
  subscriptionId: string
  /** Whole-currency-unit amount to charge (must be > 0; <= 0 is a caller bug). */
  amount: number
  currency: string
  /** Human description carried onto the Stripe invoice + line item. */
  description: string
  /** Non-period one-off kind, so it stays out of the partial period index. */
  kind: 'boost' | 'proration'
  periodStart: Date
  periodEnd: Date
  /** Free-text note persisted on the billing_invoices row. */
  notes: string
}

export type OneOffChargeResult =
  | { status: 'paid'; invoice: BillingInvoice }
  | { status: 'failed'; issue: StripeIssue }

/**
 * Charge a one-off amount immediately and, on success, persist a `paid`
 * billing_invoices row. Never mutates the caller's domain state — the caller
 * grants (boost / plan change) only after this returns `paid`.
 */
export async function chargeOneOffInvoice(
  db: Db,
  stripe: StripePaymentService,
  params: OneOffChargeParams,
): Promise<OneOffChargeResult> {
  const invoicesCol = getBillingInvoicesCollection(db)

  // Gate: a vaulted default card is required. Fail loud (classified issue) BEFORE
  // touching Stripe — the caller surfaces NO_PAYMENT_METHOD and grants nothing.
  const customer = await stripe.getCustomer(params.userId)
  if (!customer?.defaultPaymentMethodId) {
    return {
      status: 'failed',
      issue: {
        code: NO_PAYMENT_METHOD,
        category: 'card',
        retryable: true,
        message: 'No payment method on file. Add a card to be charged.',
      },
    }
  }

  // Reread any invoice persisted by a prior attempt so chargeInvoice reuses its
  // Stripe invoice instead of minting a second one past key expiry.
  const persisted = await invoicesCol.findOne({ _id: params.invoiceId })
  if (persisted?.status === 'paid') {
    // Already collected by a prior attempt whose response was lost: no new charge
    return { status: 'paid', invoice: persisted }
  }

  const started = new Date()
  // Local trace BEFORE money moves (BIL-5). 'held': never picked by the
  // charge-cron, never blocks the account.
  await invoicesCol.updateOne(
    { _id: params.invoiceId },
    {
      $setOnInsert: {
        _id: params.invoiceId,
        subscriptionId: params.subscriptionId,
        userId: params.userId,
        kind: params.kind,
        periodStart: params.periodStart,
        periodEnd: params.periodEnd,
        amount: params.amount,
        currency: params.currency,
        status: 'held',
        paymentMethod: 'stripe',
        externalReference: null,
        notes: params.notes,
        createdAt: started,
      },
      $set: { updatedAt: started },
    },
    { upsert: true },
  )
  const chargeable: ChargeableInvoice = {
    _id: params.invoiceId,
    userId: params.userId,
    amount: params.amount,
    currency: params.currency,
    externalReference: persisted?.externalReference ?? null,
    description: params.description,
  }

  const result = await stripe.chargeInvoice(chargeable, 1)
  if (result.status !== 'paid') {
    const issue = result.issue as StripeIssue
    // Keep whatever Stripe invoice the attempt produced, so reconciliation can
    // see it and a retry reuses it
    await invoicesCol.updateOne(
      { _id: params.invoiceId },
      {
        $set: {
          ...(result.stripeInvoiceId ? { externalReference: result.stripeInvoiceId } : {}),
          ...(result.invoiceNumber ? { invoiceNumber: result.invoiceNumber } : {}),
          ...(result.hostedInvoiceUrl ? { hostedInvoiceUrl: result.hostedInvoiceUrl } : {}),
          lastChargeError: issue?.message ?? 'charge failed',
          updatedAt: new Date(),
        },
      },
    )
    // Integrity failure (the charge guard voided a divergent invoice) is OUR bug,
    // not the user's card. Surface it to ops with parity to the charge-cron (which
    // holds + alerts the renewal path) — the one-off paths (change-plan upgrade,
    // boost) are exactly where the €43→€145 incident happened, so they MUST alert
    // too — and return a generic user-facing message instead of the diagnostic one
    // (which embeds internal amounts). Non-integrity failures (card declined, no
    // method) keep their upstream message so the user can act on them.
    if (issue?.category === 'integrity') {
      captureMessage('billing/amount_mismatch', 'error', {
        invoiceId: params.invoiceId,
        userId: params.userId,
        kind: params.kind,
        code: issue.code,
        message: issue.message,
      })
      return {
        status: 'failed',
        issue: { ...issue, message: 'We could not process this payment. Our team has been notified.' },
      }
    }
    return { status: 'failed', issue }
  }

  const now = new Date()
  // Mark the row paid. status:'paid' + paymentMethod:'stripe' keep the
  // charge-cron (scans pending/overdue) off it.
  await invoicesCol.updateOne(
    { _id: params.invoiceId },
    {
      $set: {
        // Reconcile what Stripe actually collected (the guard in chargeInvoice
        // guarantees it equals `amount`, but persist it so a divergence can never
        // hide again — the €43→€145 incident).
        amountCharged: result.amountPaid ?? params.amount,
        status: 'paid',
        invoiceNumber: result.invoiceNumber ?? null,
        externalReference: result.stripeInvoiceId ?? null,
        hostedInvoiceUrl: result.hostedInvoiceUrl ?? null,
        invoicePdfUrl: result.invoicePdfUrl ?? null,
        lastChargeError: null,
        updatedAt: now,
      },
    },
  )

  const invoice = await invoicesCol.findOne({ _id: params.invoiceId })
  return { status: 'paid', invoice: invoice as BillingInvoice }
}
