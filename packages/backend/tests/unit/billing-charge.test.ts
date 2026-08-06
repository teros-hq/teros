/**
 * Invoice charging + dunning (FASE 4c/4d).
 *
 * The money path. chargeInvoice creates ONE Stripe invoice per Teros invoice
 * (stable idempotency keys) and retries only the pay (per-attempt key), so a
 * re-run never double-charges. The charge-cron drives the dunning lifecycle:
 * pending → paid, or pending → overdue (backoff retries within grace) →
 * uncollectible once grace expires (account blocked transversally by the gate;
 * the plan is KEPT, decision B). A config error is NOT dunned against the user.
 *
 * MUST BITE — each assertion was confirmed red against a mutated implementation
 * (see the per-test notes). Asserts exact persisted state + exact Stripe calls,
 * not "it was called".
 */

import { describe, expect, it } from 'bun:test'
import type { Db } from 'mongodb'
import {
  BillingChargeCron,
  DEFAULT_CHARGE_OPTS,
} from '../../src/services/billing-charge-cron'
import { StripePaymentService } from '../../src/services/stripe-payment-service'
import { FakeStripe, InMemoryDb } from './_stripe-test-helpers'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const SILENT = { info() {}, warn() {}, error() {} } as any

function customer(over: Record<string, any> = {}) {
  return {
    _id: 'user_1',
    userId: 'user_1',
    stripeCustomerId: 'cus_1',
    defaultPaymentMethodId: 'pm_1',
    country: null,
    taxId: null,
    taxIdType: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }
}

function invoice(over: Record<string, any> = {}) {
  const created = new Date('2026-06-01T00:00:00Z')
  return {
    _id: 'inv_1',
    subscriptionId: 'sub_1',
    userId: 'user_1',
    periodStart: new Date('2026-05-01T00:00:00Z'),
    periodEnd: new Date('2026-06-01T00:00:00Z'),
    amount: 89,
    currency: 'EUR',
    status: 'pending',
    paymentMethod: 'stripe',
    invoiceNumber: null,
    externalReference: null,
    notes: '',
    createdAt: created,
    updatedAt: created,
    ...over,
  }
}

function activeSub(planId = 'plan_pro') {
  const now = new Date('2026-06-02T00:00:00Z')
  return {
    _id: 'sub_1',
    userId: 'user_1',
    planId,
    customAgentHoursLimit: null,
    customPrice: null,
    agentHoursUsed: 10,
    overageHours: 0,
    currentPeriodStart: now,
    currentPeriodEnd: new Date('2026-07-02T00:00:00Z'),
    status: 'active',
    startDate: now,
    endDate: null,
    paymentMethod: 'stripe',
    createdAt: now,
    updatedAt: now,
  }
}

// ── chargeInvoice (service) ─────────────────────────────────────────────────

describe('StripePaymentService.chargeInvoice', () => {
  it('charges via one Stripe invoice with correct idempotency keys', async () => {
    const db = new InMemoryDb()
    db.seed('billing_customers', [customer()])
    const stripe = new FakeStripe()
    const svc = new StripePaymentService(db as unknown as Db, stripe)

    const res = await svc.chargeInvoice(
      { _id: 'inv_1', userId: 'user_1', amount: 89, currency: 'EUR', externalReference: null },
      1,
    )

    expect(res.status).toBe('paid')
    expect(res.stripeInvoiceId).toMatch(/^in_/)
    expect(res.invoiceNumber).toMatch(/^TEROS-/)
    expect(res.hostedInvoiceUrl).toContain('https://')

    // Item amount is in cents (89 → 8900); keys are stable (no attempt) for
    // create/finalize, per-attempt for pay.
    const item = stripe.calls.find((c) => c.method === 'createInvoiceItem')
    expect((item?.args[0] as any).amount).toBe(8900)
    expect(item?.idempotencyKey).toBe('ii:inv_1')
    // Regression (bug found via the billing E2E smoke): the line item MUST be
    // attached to the same invoice that gets finalized + paid. Without `invoice`
    // the item is stranded → the invoice finalizes at €0 → Stripe auto-pays the
    // empty invoice → pay() throws "Invoice is already paid" and the charge never
    // lands. The invoice must be CREATED before the item is attached.
    expect((item?.args[0] as any).invoice).toBe(res.stripeInvoiceId)
    const calls = stripe.calls.map((c) => c.method)
    expect(calls.indexOf('createInvoice')).toBeLessThan(calls.indexOf('createInvoiceItem'))
    expect(stripe.calls.find((c) => c.method === 'createInvoice')?.idempotencyKey).toBe('inv:inv_1')
    expect(stripe.calls.find((c) => c.method === 'finalizeInvoice')?.idempotencyKey).toBe('fin:inv_1')
    expect(stripe.calls.find((c) => c.method === 'payInvoice')?.idempotencyKey).toBe('pay:inv_1:1')
  })

  it('fails fast with NO_PAYMENT_METHOD and makes no Stripe calls when no card', async () => {
    const db = new InMemoryDb()
    db.seed('billing_customers', [customer({ defaultPaymentMethodId: null })])
    const stripe = new FakeStripe()
    const svc = new StripePaymentService(db as unknown as Db, stripe)

    const res = await svc.chargeInvoice(
      { _id: 'inv_1', userId: 'user_1', amount: 89, currency: 'EUR', externalReference: null },
      1,
    )

    expect(res.status).toBe('failed')
    expect(res.issue?.code).toBe('NO_PAYMENT_METHOD')
    expect(stripe.calls).toHaveLength(0)
  })

  it('on a card decline returns failed + the classified issue, with the Stripe invoice id kept', async () => {
    const db = new InMemoryDb()
    db.seed('billing_customers', [customer()])
    const stripe = new FakeStripe()
    stripe.chargeBehavior = () => {
      throw { type: 'StripeCardError', decline_code: 'insufficient_funds', message: 'Insufficient funds.' }
    }
    const svc = new StripePaymentService(db as unknown as Db, stripe)

    const res = await svc.chargeInvoice(
      { _id: 'inv_1', userId: 'user_1', amount: 89, currency: 'EUR', externalReference: null },
      1,
    )

    expect(res.status).toBe('failed')
    expect(res.issue?.code).toBe('INSUFFICIENT_FUNDS')
    // The invoice was created+finalized before the pay failed, so we keep its id
    // for the user to pay via the hosted page.
    expect(res.stripeInvoiceId).toBeTruthy()
    expect(res.hostedInvoiceUrl).toContain('https://')
  })

  it('reuses an existing Stripe invoice on retry (no second create) and does not re-charge on a replayed key', async () => {
    const db = new InMemoryDb()
    db.seed('billing_customers', [customer()])
    const stripe = new FakeStripe()
    let charges = 0
    stripe.chargeBehavior = () => {
      charges += 1
    }
    const svc = new StripePaymentService(db as unknown as Db, stripe)

    // First charge creates the Stripe invoice.
    const first = await svc.chargeInvoice(
      { _id: 'inv_1', userId: 'user_1', amount: 89, currency: 'EUR', externalReference: null },
      1,
    )
    // Re-run of the SAME attempt (crash before persist): reuse the invoice id,
    // replayed pay key → no second charge.
    const again = await svc.chargeInvoice(
      { _id: 'inv_1', userId: 'user_1', amount: 89, currency: 'EUR', externalReference: first.stripeInvoiceId ?? null },
      1,
    )

    expect(again.status).toBe('paid')
    expect(charges).toBe(1) // charge applied exactly once
    // Only one invoice ever created.
    expect(stripe.calls.filter((c) => c.method === 'createInvoice')).toHaveLength(1)
  })
})

// ── charge-cron (dunning lifecycle) ─────────────────────────────────────────

function makeCron(db: InMemoryDb, stripe: FakeStripe, opts = {}) {
  const svc = new StripePaymentService(db as unknown as Db, stripe)
  return new BillingChargeCron(db as unknown as Db, SILENT, svc, null, {
    ...DEFAULT_CHARGE_OPTS,
    ...opts,
  })
}

describe('BillingChargeCron', () => {
  it('charges a pending Stripe invoice and persists the Stripe fields', async () => {
    const db = new InMemoryDb()
    db.seed('billing_customers', [customer()])
    db.seed('billing_invoices', [invoice()])
    const stripe = new FakeStripe()

    const res = await makeCron(db, stripe).runOnce()

    expect(res).toEqual({ charged: 1, failed: 0, blocked: 0 })
    const stored = await db.collection('billing_invoices').findOne({ _id: 'inv_1' })
    expect(stored?.status).toBe('paid')
    expect(stored?.externalReference).toBeTruthy()
    expect(stored?.invoiceNumber).toMatch(/^TEROS-/)
    expect(stored?.attemptCount).toBe(1)
    expect(stored?.nextAttemptAt).toBeNull()
  })

  it('waives a €0 invoice without calling Stripe', async () => {
    const db = new InMemoryDb()
    db.seed('billing_customers', [customer()])
    db.seed('billing_invoices', [invoice({ amount: 0 })])
    const stripe = new FakeStripe()

    await makeCron(db, stripe).runOnce()

    const stored = await db.collection('billing_invoices').findOne({ _id: 'inv_1' })
    expect(stored?.status).toBe('waived')
    expect(stripe.calls).toHaveLength(0)
  })

  it('ignores manual invoices', async () => {
    const db = new InMemoryDb()
    db.seed('billing_customers', [customer()])
    db.seed('billing_invoices', [invoice({ paymentMethod: 'manual' })])
    const stripe = new FakeStripe()

    const res = await makeCron(db, stripe).runOnce()

    expect(res.charged).toBe(0)
    expect((await db.collection('billing_invoices').findOne({ _id: 'inv_1' }))?.status).toBe('pending')
  })

  it('on a decline within grace marks overdue + schedules a retry, without degrading', async () => {
    const db = new InMemoryDb()
    db.seed('billing_customers', [customer()])
    // Created recently → still within the 7-day grace window.
    const recent = new Date(Date.now() - 1 * DAY)
    db.seed('billing_invoices', [invoice({ createdAt: recent, updatedAt: recent })])
    db.seed('billing_subscriptions', [activeSub()])
    const stripe = new FakeStripe()
    stripe.chargeBehavior = () => {
      throw { type: 'StripeCardError', decline_code: 'insufficient_funds', message: 'no funds' }
    }

    const res = await makeCron(db, stripe).runOnce()

    expect(res).toEqual({ charged: 0, failed: 1, blocked: 0 })
    const stored = await db.collection('billing_invoices').findOne({ _id: 'inv_1' })
    expect(stored?.status).toBe('overdue')
    expect(stored?.attemptCount).toBe(1)
    expect(stored?.lastChargeError).toBe('INSUFFICIENT_FUNDS')
    expect(stored?.nextAttemptAt).toBeInstanceOf(Date)
    expect(stored?.gracePeriodEndsAt).toBeInstanceOf(Date)
    // Sub still on its paid plan.
    expect((await db.collection('billing_subscriptions').findOne({ _id: 'sub_1' }))?.status).toBe('active')
    expect((await db.collection('billing_subscriptions').findOne({ status: 'active' }))?.planId).toBe('plan_pro')
  })

  it('persists the Stripe invoice id on a FAILED charge so a later retry reuses it, never double-charges (TER-622)', async () => {
    const db = new InMemoryDb()
    db.seed('billing_customers', [customer()])
    const recent = new Date(Date.now() - 1 * DAY) // within grace → overdue + retriable
    db.seed('billing_invoices', [invoice({ createdAt: recent, updatedAt: recent })])
    db.seed('billing_subscriptions', [activeSub()])
    const stripe = new FakeStripe()
    // The pay() fails AFTER the invoice was created + finalized (decline).
    stripe.chargeBehavior = () => {
      throw { type: 'StripeCardError', decline_code: 'insufficient_funds', message: 'no funds' }
    }
    const createInvoiceCalls = () => stripe.calls.filter((c) => c.method === 'createInvoice').length

    await makeCron(db, stripe).runOnce()

    const stored = await db.collection('billing_invoices').findOne({ _id: 'inv_1' })
    expect(stored?.status).toBe('overdue')
    // The Stripe invoice id is KEPT on failure (the bug dropped it → null).
    expect(stored?.externalReference).toMatch(/^in_/)
    expect(createInvoiceCalls()).toBe(1)

    // A retry past Stripe's ~24h idempotency window (cleared keys) + due now MUST
    // reuse the persisted invoice, not mint a second one (which would double-charge
    // if the first pay had actually landed).
    await db.collection('billing_invoices').updateOne({ _id: 'inv_1' }, { $set: { nextAttemptAt: null } })
    stripe.clearIdempotency()
    await makeCron(db, stripe).runOnce()

    // MUST BITE: drop externalReference from the failure $set → the row is null →
    // chargeInvoice re-creates → createInvoice runs twice → double Stripe invoice.
    expect(createInvoiceCalls()).toBe(1)
  })

  it('once grace has expired marks uncollectible and blocks WITHOUT degrading (decision B)', async () => {
    const db = new InMemoryDb()
    db.seed('billing_customers', [customer()])
    // Invoice created 20 days ago, already overdue from prior attempts → past the
    // 7-day grace window.
    const created = new Date(Date.now() - 20 * DAY)
    db.seed('billing_invoices', [
      invoice({ status: 'overdue', attemptCount: 4, createdAt: created, updatedAt: created }),
    ])
    db.seed('billing_subscriptions', [activeSub()])
    const stripe = new FakeStripe()
    stripe.chargeBehavior = () => {
      throw { type: 'StripeCardError', decline_code: 'generic_decline', message: 'declined' }
    }

    const res = await makeCron(db, stripe).runOnce()

    expect(res.blocked).toBe(1)
    const stored = await db.collection('billing_invoices').findOne({ _id: 'inv_1' })
    expect(stored?.status).toBe('uncollectible')
    // MUST BITE: the old behavior degraded the plan (ended sub_1 + opened a basic
    // starter). Decision B keeps the plan — the gate blocks via the invoice state.
    expect((await db.collection('billing_subscriptions').findOne({ _id: 'sub_1' }))?.status).toBe('active')
    const active = await db.collection('billing_subscriptions').findOne({ status: 'active' })
    expect(active?.planId).toBe('plan_pro')
    expect(active?._id).toBe('sub_1')
  })

  it('blocks at the 7-day grace boundary (decision C): 10 days overdue → uncollectible', async () => {
    const db = new InMemoryDb()
    db.seed('billing_customers', [customer()])
    // Created 10 days ago: past the 7-day grace, but WITHIN the old 14-day one.
    // MUST BITE: reverting graceDays to 14 keeps this 'overdue' (not blocked).
    const created = new Date(Date.now() - 10 * DAY)
    db.seed('billing_invoices', [
      invoice({ status: 'overdue', attemptCount: 2, createdAt: created, updatedAt: created }),
    ])
    db.seed('billing_subscriptions', [activeSub()])
    const stripe = new FakeStripe()
    stripe.chargeBehavior = () => {
      throw { type: 'StripeCardError', decline_code: 'generic_decline', message: 'declined' }
    }

    const res = await makeCron(db, stripe).runOnce()

    expect(res.blocked).toBe(1)
    expect((await db.collection('billing_invoices').findOne({ _id: 'inv_1' }))?.status).toBe('uncollectible')
  })

  it('does NOT dun the user on a config error (broken Stripe key)', async () => {
    const db = new InMemoryDb()
    db.seed('billing_customers', [customer()])
    db.seed('billing_invoices', [invoice()])
    db.seed('billing_subscriptions', [activeSub()])
    const stripe = new FakeStripe()
    stripe.chargeBehavior = () => {
      throw { type: 'StripeAuthenticationError', message: 'Invalid API Key' }
    }

    const res = await makeCron(db, stripe).runOnce()

    expect(res).toEqual({ charged: 0, failed: 1, blocked: 0 })
    const stored = await db.collection('billing_invoices').findOne({ _id: 'inv_1' })
    // Stays pending (NOT overdue) — the user is blameless; ops gets alerted.
    expect(stored?.status).toBe('pending')
    expect(stored?.lastChargeError).toBe('CONFIG_ERROR')
    expect(stored?.nextAttemptAt ?? undefined).toBeUndefined()
  })

  it('skips an invoice whose nextAttemptAt is still in the future', async () => {
    const db = new InMemoryDb()
    db.seed('billing_customers', [customer()])
    db.seed('billing_invoices', [
      invoice({ status: 'overdue', nextAttemptAt: new Date(Date.now() + DAY) }),
    ])
    const stripe = new FakeStripe()

    const res = await makeCron(db, stripe).runOnce()

    expect(res.charged).toBe(0)
    expect(stripe.calls).toHaveLength(0)
  })

  it('is a no-op when Stripe is not configured', async () => {
    const db = new InMemoryDb()
    db.seed('billing_invoices', [invoice()])
    const svc = new StripePaymentService(db as unknown as Db, null)
    const cron = new BillingChargeCron(db as unknown as Db, SILENT, svc, null)

    const res = await cron.runOnce()
    expect(res).toEqual({ charged: 0, failed: 0, blocked: 0 })
    expect((await db.collection('billing_invoices').findOne({ _id: 'inv_1' }))?.status).toBe('pending')
  })
})
