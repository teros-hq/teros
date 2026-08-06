/**
 * Stripe Webhook Handler — `POST /webhooks/stripe` (FASE 4e).
 *
 * A SECONDARY status sync + safety net (the charge-cron is the authority that
 * actually charges and owns the dunning schedule). Verifies the Stripe
 * signature, dedups by event id, and reflects the payment outcome onto the Teros
 * invoice. It NEVER charges and NEVER degrades — those stay with the cron — so
 * the two paths can't conflict; both just converge on the invoice status.
 *
 * Signature verification uses the real SDK (stripe.webhooks.constructEvent via
 * the StripePaymentService), which checks the timestamp tolerance + HMAC and
 * rejects replays/forgeries.
 */

import type { IncomingMessage, ServerResponse } from 'http'
import type { Db } from 'mongodb'
import type { Logger } from 'pino'
import { isMongoDuplicateKey } from '../lib/mongo-errors.js'
import { getBillingInvoicesCollection } from '../models/billing.js'
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

/**
 * Apply a verified Stripe event to Teros state, idempotently. Exposed for unit
 * tests (no HTTP). Dedups via billing_webhook_events (unique _id = event id).
 */
export async function applyStripeWebhookEvent(
  db: Db,
  event: StripeEventRef,
  now: Date,
): Promise<ApplyResult> {
  // Dedup-first: claim the event id atomically (unique _id) so two concurrent
  // deliveries can't both apply. A redelivery of an already-applied event is a
  // no-op.
  try {
    await db
      .collection('billing_webhook_events')
      .insertOne({ _id: event.id as any, type: event.type, receivedAt: now })
  } catch (err) {
    if (isMongoDuplicateKey(err)) return { deduped: true, handled: false }
    throw err
  }

  // Apply the effect; if it throws AFTER we claimed the dedup slot, ROLL THE SLOT
  // BACK so a Stripe redelivery RE-APPLIES instead of being swallowed as a
  // duplicate (TER-623). Otherwise a transient Mongo blip on an invoice.paid
  // update would mark the event "processed" yet never update the invoice → the
  // user stays "paid but blocked" forever. Then rethrow → 500 → Stripe retries.
  try {
    return await applyVerifiedEventEffect(db, event, now)
  } catch (err) {
    await db
      .collection('billing_webhook_events')
      .deleteOne({ _id: event.id as any })
      .catch(() => {})
    throw err
  }
}

/** The state effect of a verified, deduped event. Separated so the caller can roll
 *  back the dedup claim if any of these writes throws (TER-623). */
async function applyVerifiedEventEffect(
  db: Db,
  event: StripeEventRef,
  now: Date,
): Promise<ApplyResult> {
  const object = event.data.object as Record<string, any>
  const invoicesCol = getBillingInvoicesCollection(db)

  // Resolve the Teros invoice: prefer the metadata link we stamped on create,
  // fall back to matching the Stripe invoice id.
  const terosInvoiceId =
    typeof object.metadata?.terosInvoiceId === 'string' ? object.metadata.terosInvoiceId : null
  const invoice =
    (terosInvoiceId ? await invoicesCol.findOne({ _id: terosInvoiceId }) : null) ??
    (typeof object.id === 'string' ? await invoicesCol.findOne({ externalReference: object.id }) : null)

  switch (event.type) {
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      if (!invoice) return { handled: true, reason: 'no matching invoice' }
      await invoicesCol.updateOne(
        { _id: invoice._id },
        {
          $set: {
            status: 'paid',
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
      await invoicesCol.updateOne(
        { _id: invoice._id },
        { $set: { status: 'overdue', lastChargeError: 'PAYMENT_FAILED', updatedAt: now } },
      )
      return { handled: true, status: 'overdue' }
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
