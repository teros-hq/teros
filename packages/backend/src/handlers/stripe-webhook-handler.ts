/**
 * Stripe Webhook Handler — `POST /webhooks/stripe` (FASE 4e).
 *
 * A SECONDARY status sync + safety net (the charge-cron is the authority that
 * actually charges and owns the dunning schedule). Verifies the Stripe
 * signature, dedups by event id, and reflects the payment outcome onto the Teros
 * invoice. It NEVER charges and NEVER degrades — those stay with the cron — so
 * the two paths can't conflict; both just converge on the invoice status.
 *
 * Handled: invoice.paid / invoice.payment_succeeded / invoice.payment_failed /
 * invoice.voided / charge.refunded / payment_method.detached / customer.deleted.
 * Subscribe exactly these in the Stripe dashboard endpoint.
 *
 * Signature verification uses the real SDK (stripe.webhooks.constructEvent via
 * the StripePaymentService), which checks the timestamp tolerance + HMAC and
 * rejects replays/forgeries.
 */

import type { IncomingMessage, ServerResponse } from 'http'
import type { Db } from 'mongodb'
import type { Logger } from 'pino'
import { isMongoDuplicateKey } from '../lib/mongo-errors.js'
import {
  type BillingInvoice,
  getBillingCustomersCollection,
  getBillingInvoicesCollection,
} from '../models/billing.js'
import { fromStripeAmount } from '../services/stripe-api.js'
import { captureMessage } from '../lib/sentry.js'
import type { StripePaymentService } from '../services/stripe-payment-service.js'
import type { StripeEventRef } from '../services/stripe-api.js'

export interface ApplyResult {
  /** The event was a duplicate delivery and was skipped. */
  deduped?: boolean
  /** A handler matched and ran for this event type. */
  handled: boolean
  /** Resulting Teros invoice status, when one was touched. */
  status?: string
  reason?: string
}

/** A 'processing' claim older than this is presumed dead and can be re-claimed. */
const STALE_CLAIM_MS = 5 * 60_000

/** Thrown when another delivery of the same event is being applied right now. */
export class WebhookEventInFlightError extends Error {
  constructor(eventId: string) {
    super(`Stripe event ${eventId} is being processed by another delivery`)
  }
}

/**
 * Apply a verified Stripe event to Teros state, idempotently. Exposed for unit
 * tests (no HTTP). Dedups via billing_webhook_events (unique _id = event id).
 *
 * Two-phase claim (BIL-6): the event is claimed as 'processing' and marked
 * 'applied' only after its effect lands. A process that dies in between used
 * to leave the event claimed forever — every Stripe redelivery was discarded
 * as a duplicate and the effect never happened. Now a stale 'processing' claim
 * is taken over by the next delivery; a fresh one (a concurrent delivery)
 * makes this delivery fail with 500 so Stripe retries it later.
 */
export async function applyStripeWebhookEvent(
  db: Db,
  event: StripeEventRef,
  now: Date,
): Promise<ApplyResult> {
  const events = db.collection<{ _id: string; type: string; receivedAt: Date; status?: string; claimedAt?: Date }>(
    'billing_webhook_events',
  )
  try {
    await events.insertOne({ _id: event.id, type: event.type, receivedAt: now, status: 'processing', claimedAt: now })
  } catch (err) {
    if (!isMongoDuplicateKey(err)) throw err
    const existing = await events.findOne({ _id: event.id })
    // Rows from before the two-phase claim have no status: they were applied
    if (!existing || existing.status === undefined || existing.status === 'applied') {
      return { deduped: true, handled: false }
    }
    const reclaimed = await events.findOneAndUpdate(
      { _id: event.id, status: 'processing', claimedAt: { $lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
      { $set: { claimedAt: now } },
    )
    if (!reclaimed) throw new WebhookEventInFlightError(event.id)
  }

  // Apply the effect; if it throws, ROLL THE CLAIM BACK so a Stripe redelivery
  // RE-APPLIES instead of being swallowed as a duplicate (TER-623). Otherwise a
  // transient Mongo blip on an invoice.paid update would mark the event
  // "processed" yet never update the invoice → the user stays "paid but blocked"
  // forever. Then rethrow → 500 → Stripe retries.
  let result: ApplyResult
  try {
    result = await applyVerifiedEventEffect(db, event, now)
  } catch (err) {
    await events.deleteOne({ _id: event.id }).catch(() => {})
    throw err
  }
  await events.updateOne({ _id: event.id }, { $set: { status: 'applied', appliedAt: new Date() } })
  return result
}

/** Invoice statuses an invoice.paid event may move to 'paid' (BIL-6). */
const PAYABLE_STATUSES: BillingInvoice['status'][] = ['pending', 'overdue', 'uncollectible', 'invoiced', 'paid']

/** The state effect of a verified, deduped event. Separated so the caller can roll
 *  back the dedup claim if any of these writes throws (TER-623). */
async function applyVerifiedEventEffect(
  db: Db,
  event: StripeEventRef,
  now: Date,
): Promise<ApplyResult> {
  const object = event.data.object as Record<string, any>
  const invoicesCol = getBillingInvoicesCollection(db)
  const customersCol = getBillingCustomersCollection(db)

  // ── Customer-level events: no invoice to resolve ─────────────────────────
  switch (event.type) {
    case 'payment_method.detached': {
      // The card was removed in Stripe (dashboard / customer portal). Forget it as
      // the default so the next charge fails with NO_PAYMENT_METHOD (dunning asks
      // for a card) instead of a confusing decline on a detached method.
      const pmId = typeof object.id === 'string' ? object.id : null
      if (!pmId) return { handled: true, reason: 'no payment method id' }
      const res = await customersCol.updateMany(
        { defaultPaymentMethodId: pmId },
        { $set: { defaultPaymentMethodId: null, updatedAt: now } },
      )
      return { handled: true, reason: `cleared default on ${res.modifiedCount} customer(s)` }
    }
    case 'customer.deleted': {
      // The Stripe customer is gone: drop the mapping so createOrSyncCustomer
      // mints a fresh one on the next payment action (the unique index on
      // stripeCustomerId would otherwise pin the user to a dead customer forever).
      const cusId = typeof object.id === 'string' ? object.id : null
      if (!cusId) return { handled: true, reason: 'no customer id' }
      const mapping = await customersCol.findOne({ stripeCustomerId: cusId })
      if (!mapping) return { handled: true, reason: 'no matching customer' }
      await customersCol.deleteOne({ _id: mapping._id })
      captureMessage('billing/stripe_customer_deleted', 'warning', { userId: mapping.userId, stripeCustomerId: cusId })
      return { handled: true, reason: `mapping removed for ${mapping.userId}` }
    }
    default:
      break
  }

  // Resolve the Teros invoice: prefer the metadata link we stamped on create,
  // fall back to matching the Stripe invoice id (or, for a charge, its invoice).
  const terosInvoiceId =
    typeof object.metadata?.terosInvoiceId === 'string' ? object.metadata.terosInvoiceId : null
  const stripeInvoiceId =
    event.type === 'charge.refunded'
      ? (typeof object.invoice === 'string' ? object.invoice : (object.invoice?.id ?? null))
      : (typeof object.id === 'string' ? object.id : null)
  const invoice =
    (terosInvoiceId ? await invoicesCol.findOne({ _id: terosInvoiceId }) : null) ??
    (stripeInvoiceId ? await invoicesCol.findOne({ externalReference: stripeInvoiceId }) : null)

  switch (event.type) {
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      if (!invoice) return { handled: true, reason: 'no matching invoice' }
      // Only invoices still owed become paid (BIL-6). A waived or refunded
      // invoice is never flipped back. A 'held' one is a one-off charge
      // (boost / upgrade) either in flight — the in-app path marks it paid
      // itself — or failed and later paid on the hosted page, where the user
      // got nothing: the daily reconciliation alerts on that, so leave it.
      if (!PAYABLE_STATUSES.includes(invoice.status)) {
        return { handled: true, status: invoice.status, reason: `not payable from ${invoice.status}` }
      }
      await invoicesCol.updateOne(
        { _id: invoice._id, status: { $in: PAYABLE_STATUSES } },
        {
          $set: {
            status: 'paid',
            // What Stripe actually collected — the same field the charge-cron
            // writes, so the quote/charge comparison never has a hole.
            ...(typeof object.amount_paid === 'number' ? { amountCharged: fromStripeAmount(object.amount_paid) } : {}),
            externalReference: typeof object.id === 'string' ? object.id : invoice.externalReference,
            invoiceNumber: object.number ?? invoice.invoiceNumber,
            hostedInvoiceUrl: object.hosted_invoice_url ?? invoice.hostedInvoiceUrl ?? null,
            invoicePdfUrl: object.invoice_pdf ?? invoice.invoicePdfUrl ?? null,
            nextAttemptAt: null,
            lastChargeError: null,
            updatedAt: now,
          },
        },
      )
      return { handled: true, status: 'paid' }
    }
    case 'invoice.payment_failed': {
      if (!invoice) return { handled: true, reason: 'no matching invoice' }
      // Only mark overdue if still collectible — never overwrite a paid or
      // already-degraded (uncollectible) invoice. The cron owns the retry
      // schedule, so we don't touch attemptCount/nextAttemptAt here.
      if (invoice.status !== 'pending' && invoice.status !== 'overdue') {
        return { handled: true, status: invoice.status }
      }
      // Conditional write (BIL-6): an invoice.paid that landed between the read
      // above and this write must not be overwritten with overdue.
      const res = await invoicesCol.updateOne(
        { _id: invoice._id, status: { $in: ['pending', 'overdue'] } },
        { $set: { status: 'overdue', lastChargeError: 'PAYMENT_FAILED', updatedAt: now } },
      )
      return res.modifiedCount > 0 || res.matchedCount > 0
        ? { handled: true, status: 'overdue' }
        : { handled: true, reason: 'status changed concurrently; left as is' }
    }
    case 'charge.refunded': {
      if (!invoice) return { handled: true, reason: 'no matching invoice' }
      const refunded = typeof object.amount_refunded === 'number' ? fromStripeAmount(object.amount_refunded) : null
      const full = typeof object.amount === 'number' && typeof object.amount_refunded === 'number' && object.amount_refunded >= object.amount
      await invoicesCol.updateOne(
        { _id: invoice._id },
        {
          $set: {
            ...(full ? { status: 'refunded' } : {}),
            ...(refunded !== null ? { refundedAmount: refunded } : {}),
            refundedAt: now,
            updatedAt: now,
          },
        },
      )
      captureMessage('billing/stripe_refund', 'warning', {
        invoiceId: invoice._id,
        userId: invoice.userId,
        refundedAmount: refunded,
        full,
        stripeInvoiceId: invoice.externalReference,
      })
      return { handled: true, status: full ? 'refunded' : invoice.status }
    }
    case 'invoice.voided': {
      // Voided on the Stripe side (dashboard): a pending/overdue Teros invoice
      // must not keep pointing at a dead invoice, or every retry would reuse it
      // and be refused forever. Clear the reference so the next attempt mints a
      // fresh one. Paid / held / waived invoices are left alone.
      if (!invoice) return { handled: true, reason: 'no matching invoice' }
      if (invoice.status !== 'pending' && invoice.status !== 'overdue') {
        return { handled: true, status: invoice.status }
      }
      await invoicesCol.updateOne(
        { _id: invoice._id },
        { $set: { externalReference: null, invoiceNumber: null, hostedInvoiceUrl: null, invoicePdfUrl: null, lastChargeError: 'STRIPE_VOIDED', updatedAt: now } },
      )
      return { handled: true, status: invoice.status, reason: 'stripe invoice voided; reference cleared' }
    }
    default:
      return { handled: false, reason: `unhandled type ${event.type}` }
  }
}

export class StripeWebhookHandler {
  constructor(
    private readonly db: Db,
    private readonly stripe: StripePaymentService,
    private readonly log: Logger,
  ) {}

  async handleRoute(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
    if (!url.startsWith('/webhooks/stripe')) return false
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'Method not allowed' })
      return true
    }
    if (!this.stripe.isEnabled()) {
      this.sendJson(res, 503, { error: 'Stripe not configured' })
      return true
    }

    const rawBody = await this.readRawBody(req)
    const sigHeader = req.headers['stripe-signature']
    const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader
    if (!signature) {
      this.sendJson(res, 400, { error: 'Missing stripe-signature header' })
      return true
    }

    let event: StripeEventRef
    try {
      event = await this.stripe.verifyWebhookEvent(rawBody, signature)
    } catch (err) {
      this.log.warn({ err }, 'stripe-webhook: signature verification failed')
      this.sendJson(res, 400, { error: 'Invalid signature' })
      return true
    }

    try {
      const result = await applyStripeWebhookEvent(this.db, event, new Date())
      this.log.info({ type: event.type, id: event.id, result }, 'stripe-webhook: processed')
    } catch (err) {
      this.log.error({ err, type: event.type, id: event.id }, 'stripe-webhook: processing failed')
      // 500 → Stripe retries the delivery later (dedup makes the retry safe).
      this.sendJson(res, 500, { error: 'Processing failed' })
      return true
    }

    this.sendJson(res, 200, { received: true })
    return true
  }

  private readRawBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
}
