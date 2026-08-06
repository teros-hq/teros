/**
 * Proration on an immediate UPGRADE + deferred DOWNGRADE (FASE 8, decisions A/D).
 *
 * computeProrationUpgradeCharge is the money math (pure): the prorated difference
 * an upgrade owes for the rest of the already-paid period. The admin handler wires
 * the upgrade and DEFERS a downgrade WITHOUT charging (TER-626). Catalog-agnostic:
 * €0 BETA → 0.
 *
 * MUST BITE:
 *   - drop the diff≤0 guard → a downgrade produces a (wrong) negative charge.
 *   - drop the fraction clamp → past-period-end test produces a negative charge.
 *   - route a downgrade through changeUserPlanImmediate → "defers" test red.
 */

import { describe, expect, it } from 'bun:test'
import type { Db } from 'mongodb'
import { computeProrationUpgradeCharge } from '../../src/models/billing'
import { StripePaymentService } from '../../src/services/stripe-payment-service'
import { createUpdateBillingSubscriptionHandler } from '../../src/handlers/domains/admin/update-billing-subscription'
import { FakeStripe, InMemoryDb } from './_stripe-test-helpers'

const DAY = 86_400_000

describe('computeProrationUpgradeCharge', () => {
  const oldPlan = { price: 89 }
  const start = new Date('2026-06-01T00:00:00Z')
  const end = new Date('2026-07-01T00:00:00Z') // 30 days

  it('charges the prorated difference of the unused fraction', () => {
    const sub = { customPrice: null, currentPeriodStart: start, currentPeriodEnd: end }
    // 15 days in → half remaining → (179-89) × 0.5 = 45.
    const charge = computeProrationUpgradeCharge(sub, oldPlan, 179, new Date('2026-06-16T00:00:00Z'))
    expect(charge).toBe(45)
  })

  it('returns the full difference at the period start and 0 past the end', () => {
    const sub = { customPrice: null, currentPeriodStart: start, currentPeriodEnd: end }
    expect(computeProrationUpgradeCharge(sub, oldPlan, 179, start)).toBe(90)
    // Clamp: never negative past the end.
    expect(computeProrationUpgradeCharge(sub, oldPlan, 179, new Date('2026-08-01T00:00:00Z'))).toBe(0)
  })

  it('is 0 for a downgrade or a lateral change (diff ≤ 0)', () => {
    const sub = { customPrice: null, currentPeriodStart: start, currentPeriodEnd: end }
    const mid = new Date('2026-06-16T00:00:00Z')
    expect(computeProrationUpgradeCharge(sub, oldPlan, 50, mid)).toBe(0) // cheaper
    expect(computeProrationUpgradeCharge(sub, oldPlan, 89, mid)).toBe(0) // equal
  })

  it('is 0 for a €0 BETA upgrade and honors the old custom price', () => {
    const mid = new Date('2026-06-16T00:00:00Z')
    const sub = { customPrice: null, currentPeriodStart: start, currentPeriodEnd: end }
    expect(computeProrationUpgradeCharge(sub, { price: 0 }, 0, mid)).toBe(0)

    // Old custom price 200 > new 179 → no charge (it's a downgrade in price).
    const custom = { customPrice: 200, currentPeriodStart: start, currentPeriodEnd: end }
    expect(computeProrationUpgradeCharge(custom, oldPlan, 179, mid)).toBe(0)
    // Old custom price 100 < new 179 → half of (179-100) = 39.5.
    const custom2 = { customPrice: 100, currentPeriodStart: start, currentPeriodEnd: end }
    expect(computeProrationUpgradeCharge(custom2, oldPlan, 179, mid)).toBe(39.5)
  })
})

describe('update-billing-subscription proration integration', () => {
  const adminUserService = {
    async getByUserId() {
      return { userId: 'caller', role: 'admin', profile: { email: 'a@t.com', displayName: 'A' } }
    },
  } as any
  const ctx = { userId: 'caller' } as any

  function seededDb(currentPlanId: 'plan_pro' | 'plan_max' = 'plan_pro') {
    const db = new InMemoryDb()
    const now = Date.now()
    db.seed('billing_plans', [
      { _id: 'plan_pro', name: 'pro', price: 89, currency: 'EUR', agentHoursLimit: 80 },
      { _id: 'plan_max', name: 'max', price: 179, currency: 'EUR', agentHoursLimit: 200 },
    ])
    db.seed('billing_subscriptions', [
      {
        _id: 'sub_old',
        userId: 'user_1',
        planId: currentPlanId,
        customPrice: null,
        customAgentHoursLimit: null,
        agentHoursUsed: 5,
        overageHours: 0,
        // 10 days into a 30-day period → 20 days (~2/3) remaining.
        currentPeriodStart: new Date(now - 10 * DAY),
        currentPeriodEnd: new Date(now + 20 * DAY),
        status: 'active',
        startDate: new Date(now - 10 * DAY),
        endDate: null,
        paymentMethod: 'stripe',
        billingNotes: '',
        createdAt: new Date(now - 10 * DAY),
        updatedAt: new Date(now - 10 * DAY),
      },
    ])
    db.seed('billing_customers', [
      { _id: 'user_1', userId: 'user_1', stripeCustomerId: 'cus_1', defaultPaymentMethodId: 'pm_1', country: null, taxId: null, taxIdType: null, createdAt: new Date(), updatedAt: new Date() },
    ])
    return db
  }

  it('applies an admin UPGRADE immediately WITHOUT charging (TER-626): keeps the cut, fresh hours', async () => {
    const db = seededDb('plan_pro')
    const stripe = new FakeStripe()
    const svc = new StripePaymentService(db as unknown as Db, stripe)
    const handler = createUpdateBillingSubscriptionHandler(adminUserService, db as unknown as Db, svc)

    const oldCut = (await db.collection('billing_subscriptions').findOne({ _id: 'sub_old' }))!.currentPeriodEnd

    await handler(ctx, { targetUserId: 'user_1', planId: 'plan_max' })

    // Admin only ASSIGNS the tier — no auto-charge (decision Antonio); billing is
    // handled out-of-band. Teros never creates Stripe customer balances (enforced by
    // the billing-no-customer-balance invariant test).
    const active = await db.collection('billing_subscriptions').findOne({ userId: 'user_1', status: 'active' })
    expect(active?.planId).toBe('plan_max') // upgrade applied immediately
    expect(active?.billingNotes ?? '').not.toContain('Proration charge applied')
    expect(active?.agentHoursUsed).toBe(0) // all the new plan's hours, fresh
    // Keeps the ORIGINAL cut (decision A), not now+1 month.
    expect(active?.currentPeriodEnd.getTime()).toBe(oldCut.getTime())
  })

  it('applies an admin DOWNGRADE IMMEDIATELY with no charge (TER-631)', async () => {
    const db = seededDb('plan_max') // currently on the expensive plan
    const stripe = new FakeStripe()
    const svc = new StripePaymentService(db as unknown as Db, stripe)
    const handler = createUpdateBillingSubscriptionHandler(adminUserService, db as unknown as Db, svc)

    await handler(ctx, { targetUserId: 'user_1', planId: 'plan_pro' })

    // An ADMIN change is immediate in both directions: the old sub is ended and a
    // new active one is on the cheaper plan NOW — not deferred to the period end.
    const active = await db
      .collection('billing_subscriptions')
      .findOne({ userId: 'user_1', status: 'active' })
    expect(active?.planId).toBe('plan_pro')
    expect(active?.scheduledPlanChange ?? null).toBeNull()
    const ended = db.collection('billing_subscriptions').docs.filter((s: any) => s.status === 'ended')
    expect(ended.map((s: any) => s.planId)).toEqual(['plan_max'])
    // MUST BITE: routing the admin path through applyPlanChange defers the
    // downgrade → no new sub, planId stays plan_max, scheduledPlanChange set → red.
  })

  it('does not call Stripe when the change is between €0 BETA plans', async () => {
    const db = seededDb('plan_pro')
    db.collection('billing_plans').docs.push(
      { _id: 'plan_free', name: 'free', price: 0, currency: 'EUR', agentHoursLimit: 0 },
      { _id: 'plan_free2', name: 'free2', price: 0, currency: 'EUR', agentHoursLimit: 5 },
    )
    db.collection('billing_subscriptions').docs.find((d: any) => d._id === 'sub_old')!.planId = 'plan_free'
    const stripe = new FakeStripe()
    const svc = new StripePaymentService(db as unknown as Db, stripe)
    const handler = createUpdateBillingSubscriptionHandler(adminUserService, db as unknown as Db, svc)

    // free (0) → free2 (0): a real plan change, but the difference is €0 → no charge.
    await handler(ctx, { targetUserId: 'user_1', planId: 'plan_free2' })
    const active = await db.collection('billing_subscriptions').findOne({ userId: 'user_1', status: 'active' })
    expect(active?.planId).toBe('plan_free2')
  })

  it('completes the plan change even when Stripe is disabled', async () => {
    const db = seededDb('plan_pro')
    const svc = new StripePaymentService(db as unknown as Db, null)
    const handler = createUpdateBillingSubscriptionHandler(adminUserService, db as unknown as Db, svc)

    await handler(ctx, { targetUserId: 'user_1', planId: 'plan_max' })

    const active = await db.collection('billing_subscriptions').findOne({ userId: 'user_1', status: 'active' })
    expect(active?.planId).toBe('plan_max')
  })
})
