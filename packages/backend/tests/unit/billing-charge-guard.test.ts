/**
 * chargeInvoice amount guard (TER-702) — the €43→€145 regression net.
 *
 * A leftover POSITIVE customer balance is swept into an invoice on finalization
 * (Stripe cannot opt out per-invoice), inflating what the card pays above the
 * quote. The guard runs between finalize and pay — on BOTH the create and the
 * reuse (crashed-prior-attempt) paths — and, on any divergence, VOIDS the invoice
 * (so no card is charged) and returns an `integrity` failure (no dunning, no block).
 *
 * MUST BITE — each assertion was confirmed red against a mutated implementation:
 *   - drop the guard          → the swept invoice is PAID (€132), tests 1/2 fail.
 *   - guard only in create    → the reuse path pays, test 2 fails.
 *   - drop amountPaid recon    → test 3's amountPaid is undefined.
 *   - re-pay/void a paid reuse → test 4 fails (extra pay/void call).
 *   - dun the integrity fail   → test 5's status is 'overdue', not 'held'.
 */

import { describe, expect, it } from 'bun:test'
import type { Db } from 'mongodb'
import { BillingChargeCron, DEFAULT_CHARGE_OPTS } from '../../src/services/billing-charge-cron'
import { chargeOneOffInvoice } from '../../src/services/billing-one-off-charge'
import { StripePaymentService } from '../../src/services/stripe-payment-service'
import { FakeStripe, InMemoryDb } from './_stripe-test-helpers'

const SILENT = { info() {}, warn() {}, error() {} } as any

function customer(over: Record<string, any> = {}) {
  return {
    _id: 'user_1',
    userId: 'user_1',
    stripeCustomerId: 'cus_1',
    defaultPaymentMethodId: 'pm_1',
    country: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }
}

const chargeable = { _id: 'inv_1', userId: 'user_1', amount: 89, currency: 'EUR', externalReference: null }
const methods = (s: FakeStripe) => s.calls.map((c) => c.method)

describe('chargeInvoice amount guard', () => {
  it('voids and refuses when a customer balance would be swept in (create path)', async () => {
    const db = new InMemoryDb()
    db.seed('billing_customers', [customer()])
    const stripe = new FakeStripe()
    stripe.seedCustomerBalance('cus_1', 8900) // €89 leftover debit from the pre-fix path

    const svc = new StripePaymentService(db as unknown as Db, stripe)
    const res = await svc.chargeInvoice(chargeable, 1)

    expect(res.status).toBe('failed')
    expect(res.issue?.code).toBe('AMOUNT_MISMATCH')
    expect(res.issue?.category).toBe('integrity')
    expect(res.issue?.retryable).toBe(false)
    // The invoice was voided and the card was NEVER charged.
    expect(methods(stripe)).toContain('voidInvoice')
    expect(methods(stripe)).not.toContain('payInvoice')
    // Voiding returns the balance to the customer so remediation can zero it.
    expect(stripe.customerBalance('cus_1')).toBe(8900)
  })

  it('runs the guard on the reuse path too (crash after finalize)', async () => {
    const db = new InMemoryDb()
    db.seed('billing_customers', [customer()])
    const stripe = new FakeStripe()
    // A prior attempt finalized the invoice — the balance already landed on
    // amount_due — then crashed before pay; externalReference was persisted.
    stripe.seedInvoice('in_pre', {
      status: 'open',
      subtotal: 8900,
      starting_balance: 8900,
      amount_due: 17800,
    })

    const svc = new StripePaymentService(db as unknown as Db, stripe)
    const res = await svc.chargeInvoice({ ...chargeable, externalReference: 'in_pre' }, 2)

    expect(res.status).toBe('failed')
    expect(res.issue?.code).toBe('AMOUNT_MISMATCH')
    // It took the reuse path (retrieve, not create) and still guarded + voided.
    expect(methods(stripe)).toContain('retrieveInvoice')
    expect(methods(stripe)).not.toContain('createInvoice')
    expect(methods(stripe)).toContain('voidInvoice')
    expect(methods(stripe)).not.toContain('payInvoice')
  })

  it('charges and reconciles amount_paid when the balance is clean', async () => {
    const db = new InMemoryDb()
    db.seed('billing_customers', [customer()])
    const stripe = new FakeStripe()

    const svc = new StripePaymentService(db as unknown as Db, stripe)
    const res = await svc.chargeInvoice(chargeable, 1)

    expect(res.status).toBe('paid')
    expect(res.amountPaid).toBe(89) // reconciled from Stripe, == quote
    expect(stripe.calls.filter((c) => c.method === 'payInvoice')).toHaveLength(1)
    expect(methods(stripe)).not.toContain('voidInvoice')
    // Prices are tax-inclusive so amount_due === quote even with tax.
    const item = stripe.calls.find((c) => c.method === 'createInvoiceItem')
    expect((item?.args[0] as any).tax_behavior).toBe('inclusive')
  })

  it('reconciles a lost-response paid invoice without re-paying or voiding', async () => {
    const db = new InMemoryDb()
    db.seed('billing_customers', [customer()])
    const stripe = new FakeStripe()
    // A prior attempt paid (€89) but its response was lost; externalReference points
    // at the paid invoice.
    stripe.seedInvoice('in_paid', { status: 'paid', paid: true, amount_paid: 8900, subtotal: 8900 })

    const svc = new StripePaymentService(db as unknown as Db, stripe)
    const res = await svc.chargeInvoice({ ...chargeable, externalReference: 'in_paid' }, 2)

    expect(res.status).toBe('paid')
    expect(res.amountPaid).toBe(89)
    expect(methods(stripe)).not.toContain('payInvoice') // not re-charged
    expect(methods(stripe)).not.toContain('voidInvoice') // never void a paid invoice
  })

  it('charge-cron HOLDS an integrity failure (no dunning, no block)', async () => {
    const db = new InMemoryDb()
    db.seed('billing_customers', [customer()])
    db.seed('billing_invoices', [
      {
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
        createdAt: new Date('2026-06-01T00:00:00Z'),
        updatedAt: new Date('2026-06-01T00:00:00Z'),
      },
    ])
    const stripe = new FakeStripe()
    stripe.seedCustomerBalance('cus_1', 8900)
    const svc = new StripePaymentService(db as unknown as Db, stripe)
    const cron = new BillingChargeCron(db as unknown as Db, SILENT, svc, null, DEFAULT_CHARGE_OPTS)

    const res = await cron.runOnce()

    expect(res.blocked).toBe(0) // NOT blocked — our bug, not the user's card
    const stored = await db.collection('billing_invoices').findOne({ _id: 'inv_1' })
    expect(stored?.status).toBe('held')
    expect(stored?.gracePeriodEndsAt).toBeUndefined() // no dunning schedule started
    expect(stored?.lastChargeError).toBe('AMOUNT_MISMATCH')
    // externalReference is cleared: it pointed at the VOIDED invoice, so leaving it
    // would make a re-charge reuse a dead invoice and loop back to held forever.
    expect(stored?.externalReference).toBeNull()
    expect(cron.getMetrics().charge_integrity_holds).toBe(1)
    // The card was never charged.
    expect(methods(stripe)).not.toContain('payInvoice')
  })

  it('charge-cron reconciles amount_paid into billing_invoices.amountCharged', async () => {
    // The central deliverable: the amount actually collected is persisted, so a
    // quote can never again silently diverge from the charge (the €43→€145 bug).
    const db = new InMemoryDb()
    db.seed('billing_customers', [customer()])
    db.seed('billing_invoices', [
      {
        _id: 'inv_ok',
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
        createdAt: new Date('2026-06-01T00:00:00Z'),
        updatedAt: new Date('2026-06-01T00:00:00Z'),
      },
    ])
    const stripe = new FakeStripe() // no leftover balance → clean charge
    const svc = new StripePaymentService(db as unknown as Db, stripe)
    const cron = new BillingChargeCron(db as unknown as Db, SILENT, svc, null, DEFAULT_CHARGE_OPTS)

    await cron.runOnce()

    const stored = await db.collection('billing_invoices').findOne({ _id: 'inv_ok' })
    expect(stored?.status).toBe('paid')
    expect(stored?.amountCharged).toBe(89) // reconciled from Stripe amount_paid
  })

  it('one-off charge (change-plan/boost) alerts ops and hides the diagnostic on integrity', async () => {
    const db = new InMemoryDb()
    db.seed('billing_customers', [customer()])
    const stripe = new FakeStripe()
    stripe.seedCustomerBalance('cus_1', 8900) // leftover → guard fires

    const res = await chargeOneOffInvoice(db as unknown as Db, svcOf(db, stripe), {
      userId: 'user_1',
      invoiceId: 'plan-change:user_1:plan_pro:req1',
      subscriptionId: 'sub_1',
      amount: 89,
      currency: 'EUR',
      description: 'Plan upgrade proration → Pro',
      kind: 'proration',
      periodStart: new Date('2026-05-01T00:00:00Z'),
      periodEnd: new Date('2026-06-01T00:00:00Z'),
      notes: 'upgrade',
    })

    expect(res.status).toBe('failed')
    if (res.status === 'failed') {
      expect(res.issue.code).toBe('AMOUNT_MISMATCH')
      // The user gets a GENERIC message — the diagnostic (with internal amounts)
      // stays in the ops alert, not surfaced to the user who did nothing wrong.
      expect(res.issue.message).not.toMatch(/Stripe would collect|customer balance/)
      expect(res.issue.message).toMatch(/could not process/i)
    }
    // No billing_invoices row persisted on a failed one-off charge.
    expect(await db.collection('billing_invoices').findOne({ _id: 'plan-change:user_1:plan_pro:req1' })).toBeNull()
    // The card was never charged.
    expect(methods(stripe)).not.toContain('payInvoice')
    expect(methods(stripe)).toContain('voidInvoice')
  })

  it('refuses an UNDER-charge too (a swept negative balance / credit)', async () => {
    // starting_balance !== 0 catches BOTH signs: a credit would charge LESS than the
    // quote. Model B never uses balances, so either direction is anomalous → refuse.
    const db = new InMemoryDb()
    db.seed('billing_customers', [customer()])
    const stripe = new FakeStripe()
    stripe.seedCustomerBalance('cus_1', -3000) // €30 credit swept in

    const res = await svcOf(db, stripe).chargeInvoice(chargeable, 1)
    expect(res.status).toBe('failed')
    expect(res.issue?.code).toBe('AMOUNT_MISMATCH')
    expect(methods(stripe)).toContain('voidInvoice')
    expect(methods(stripe)).not.toContain('payInvoice')
  })
})

function svcOf(db: InMemoryDb, stripe: FakeStripe): StripePaymentService {
  return new StripePaymentService(db as unknown as Db, stripe)
}
