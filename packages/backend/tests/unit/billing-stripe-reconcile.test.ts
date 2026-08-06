/**
 * Mongo ↔ Stripe invoice reconciliation (FASE 4g).
 *
 * The reconciliation cron's Stripe pass compares each recent Stripe-charged
 * invoice's Teros status against Stripe's. It HEALS a missed webhook (Stripe
 * collected, Teros still pending/overdue → mark paid) and ALERTS the dangerous
 * case (Teros says paid, Stripe doesn't) without changing it. Out-of-window and
 * non-Stripe invoices are skipped.
 *
 * MUST BITE:
 *   - drop the heal branch → the missed-webhook invoice stays overdue.
 *   - widen the window filter → the stale invoice gets checked (count wrong).
 *   - heal the teros_paid_stripe_unpaid case too → it would wrongly flip status.
 */

import { describe, expect, it } from 'bun:test'
import type { Db } from 'mongodb'
import { BillingReconciliationCron } from '../../src/services/billing-reconciliation-cron'
import { StripePaymentService } from '../../src/services/stripe-payment-service'
import { FakeStripe, InMemoryDb } from './_stripe-test-helpers'

const DAY = 86_400_000
const SILENT = { info() {}, warn() {}, error() {} } as any
const NOW = new Date('2026-06-17T00:00:00Z')

function inv(over: Record<string, any>) {
  return {
    subscriptionId: 'sub_x',
    userId: 'user_1',
    periodStart: new Date('2026-05-17T00:00:00Z'),
    periodEnd: new Date('2026-06-17T00:00:00Z'),
    amount: 89,
    currency: 'EUR',
    paymentMethod: 'stripe',
    invoiceNumber: null,
    notes: '',
    createdAt: new Date(NOW.getTime() - 5 * DAY),
    updatedAt: new Date(NOW.getTime() - 1 * DAY),
    ...over,
  }
}

describe('BillingReconciliationCron Stripe pass', () => {
  it('heals missed webhooks, alerts true drift, and skips out-of-window/manual invoices', async () => {
    const db = new InMemoryDb()
    db.seed('billing_invoices', [
      inv({ _id: 'i_ok', status: 'paid', externalReference: 'in_1' }),
      inv({ _id: 'i_missed', status: 'overdue', externalReference: 'in_2' }),
      inv({ _id: 'i_bad', status: 'paid', externalReference: 'in_3' }),
      // Uncollectible (dunning gave up) but later PAID in Stripe — e.g. the user
      // settled the hosted invoice. TER-624 heals it (a missed invoice.paid webhook
      // would otherwise leave them "paid but blocked" forever).
      inv({ _id: 'i_writeoff', status: 'uncollectible', externalReference: 'in_6' }),
      // Outside the 60-day window → not checked.
      inv({ _id: 'i_old', status: 'overdue', externalReference: 'in_4', updatedAt: new Date(NOW.getTime() - 90 * DAY) }),
      // Manual → not checked.
      inv({ _id: 'i_manual', status: 'overdue', externalReference: 'in_5', paymentMethod: 'manual' }),
    ])

    const stripe = new FakeStripe()
    stripe.seedInvoice('in_1', { status: 'paid', paid: true })
    stripe.seedInvoice('in_2', { status: 'paid', paid: true, number: 'TEROS-0042' })
    stripe.seedInvoice('in_3', { status: 'open', paid: false })
    stripe.seedInvoice('in_6', { status: 'paid', paid: true })
    const svc = new StripePaymentService(db as unknown as Db, stripe)

    const cron = new BillingReconciliationCron(db as unknown as Db, SILENT, null, svc)
    const res = await cron.runOnce({ now: NOW })

    expect(res.stripeChecked).toBe(4) // i_ok, i_missed, i_bad, i_writeoff (not i_old/i_manual)
    expect(res.stripeHealed).toBe(2) // i_missed + i_writeoff (uncollectible-but-paid, TER-624)
    expect(res.stripeDrift).toBe(3) // i_missed + i_writeoff (healed) + i_bad (alert)

    // i_missed healed to paid with Stripe's legal number.
    const missed = await db.collection('billing_invoices').findOne({ _id: 'i_missed' })
    expect(missed?.status).toBe('paid')
    expect(missed?.invoiceNumber).toBe('TEROS-0042')

    // i_bad is NEVER auto-changed (Teros paid, Stripe unpaid).
    expect((await db.collection('billing_invoices').findOne({ _id: 'i_bad' }))?.status).toBe('paid')
    // i_writeoff (uncollectible but paid in Stripe) IS healed to paid (TER-624) —
    // a user who settled the hosted invoice must not stay blocked.
    expect((await db.collection('billing_invoices').findOne({ _id: 'i_writeoff' }))?.status).toBe('paid')
    // i_old untouched + uninspected.
    expect((await db.collection('billing_invoices').findOne({ _id: 'i_old' }))?.status).toBe('overdue')
  })

  it('flags an amount mismatch when Stripe collected more than the quote', async () => {
    // Defense-in-depth net for the €43→€145 class: an invoice paid on BOTH sides
    // but whose card charge exceeds what Teros quoted must be surfaced (never
    // auto-changed) so ops can refund. MUST BITE: drop the amount check → drift 0.
    const db = new InMemoryDb()
    db.seed('billing_invoices', [inv({ _id: 'i_over', status: 'paid', externalReference: 'in_over' })])

    const stripe = new FakeStripe()
    // Teros quoted €89 (8900); Stripe collected €132 (a balance swept in the past).
    stripe.seedInvoice('in_over', { status: 'paid', paid: true, amount_paid: 13200 })
    const svc = new StripePaymentService(db as unknown as Db, stripe)

    const cron = new BillingReconciliationCron(db as unknown as Db, SILENT, null, svc)
    const res = await cron.runOnce({ now: NOW })

    expect(res.stripeChecked).toBe(1)
    expect(res.stripeHealed).toBe(0) // already paid on both sides — nothing to heal
    expect(res.stripeDrift).toBe(1) // the amount mismatch is flagged
    // Never auto-changed: the money already moved, ops decides the refund.
    expect((await db.collection('billing_invoices').findOne({ _id: 'i_over' }))?.status).toBe('paid')
  })

  it('is a no-op when Stripe is not configured', async () => {
    const db = new InMemoryDb()
    db.seed('billing_invoices', [inv({ _id: 'i1', status: 'overdue', externalReference: 'in_1' })])
    const svc = new StripePaymentService(db as unknown as Db, null)
    const cron = new BillingReconciliationCron(db as unknown as Db, SILENT, null, svc)

    const res = await cron.runOnce({ now: NOW })
    expect(res.stripeChecked).toBe(0)
    expect((await db.collection('billing_invoices').findOne({ _id: 'i1' }))?.status).toBe('overdue')
  })
})
