/**
 * TER-596 I1 — user-facing billing API (list-plans / get-subscription /
 * get-invoices / change-plan).
 *
 * Asserts the exact response shape (backend returns DATA, not UI strings) and the
 * upgrade-immediate / downgrade-deferred routing shared with the admin panel.
 */
import { describe, expect, test } from 'bun:test'
import { InMemoryDb } from './_stripe-test-helpers'
import { createListPlansHandler } from '../../src/handlers/domains/billing/list-plans'
import { createGetSubscriptionHandler } from '../../src/handlers/domains/billing/get-subscription'
import { createGetInvoicesHandler } from '../../src/handlers/domains/billing/get-invoices'
import { createChangePlanHandler } from '../../src/handlers/domains/billing/change-plan'

const ctx = (userId: string) => ({ userId }) as any
const D = (iso: string) => new Date(iso)

// The active sub/boost period must contain the wall-clock "now":
// getActiveBoostHours filters by now ∈ [periodStart, periodEnd), so fixed
// dates turn into a time bomb the day the period ends (this suite went red on
// 2026-07-01 exactly that way). Invoices below keep fixed dates — nothing
// filters them by now.
const DAY = 24 * 60 * 60 * 1000
const PERIOD_START = new Date(Date.now() - 15 * DAY)
const PERIOD_END = new Date(Date.now() + 15 * DAY)
const SCHEDULED_AT = new Date(Date.now() - 5 * DAY)

function seedPlans(db: InMemoryDb) {
  db.seed('billing_plans', [
    { _id: 'plan_starter', name: 'starter', displayName: 'Starter', description: 's', price: 0, postBetaPrice: 9, currency: 'EUR', agentHoursLimit: 10, features: { terosModel: true, byok: true, maxWorkspaces: -1, prioritySupport: false }, highlights: ['10h'], isPublic: true },
    { _id: 'plan_growth', name: 'growth', displayName: 'Growth', description: 'g', price: 89, currency: 'EUR', agentHoursLimit: 40, features: { terosModel: true, byok: true, maxWorkspaces: -1, prioritySupport: true }, highlights: ['40h'], popular: true, isPublic: true },
    { _id: 'plan_pro', name: 'pro', displayName: 'Pro', description: 'p', price: 179, currency: 'EUR', agentHoursLimit: 80, features: { terosModel: true, byok: true, maxWorkspaces: -1, prioritySupport: true }, isPublic: true },
    { _id: 'plan_enterprise', name: 'enterprise', displayName: 'Enterprise', description: 'e', price: 0, currency: 'EUR', agentHoursLimit: 0, features: { terosModel: true, byok: true, maxWorkspaces: -1, prioritySupport: true }, contactSales: true, isPublic: true },
    { _id: 'plan_hidden', name: 'hidden', displayName: 'Hidden', description: 'h', price: 5, currency: 'EUR', agentHoursLimit: 1, features: { terosModel: true, byok: true, maxWorkspaces: -1, prioritySupport: false }, isPublic: false },
  ])
}

function seedActiveSub(db: InMemoryDb, over: Record<string, any> = {}) {
  db.seed('billing_subscriptions', [
    {
      _id: 'sub1', userId: 'u1', planId: 'plan_growth',
      customAgentHoursLimit: null, customPrice: null, customPriceNote: null,
      agentHoursUsed: 12, overageHours: 0,
      currentPeriodStart: PERIOD_START, currentPeriodEnd: PERIOD_END,
      status: 'active', startDate: PERIOD_START, endDate: null,
      cancelAtPeriodEnd: false, scheduledPlanChange: null,
      paymentMethod: 'manual', billingNotes: '', teamId: null, terosProviderConfigId: null,
      createdAt: PERIOD_START, updatedAt: PERIOD_START,
      ...over,
    },
  ])
}

describe('billing.list-plans', () => {
  test('returns only public plans, ordered by price, with card fields', async () => {
    const db = new InMemoryDb()
    seedPlans(db)
    const res = await createListPlansHandler(db as any)(ctx('u1'), {})
    expect(res.plans.map((p: any) => p.planId)).toEqual([
      'plan_starter', // €0 self-serve
      'plan_growth', // 89
      'plan_pro', // 179
      'plan_enterprise', // contact-sales → always last
    ])
    const growth = res.plans.find((p: any) => p.planId === 'plan_growth')
    expect(growth).toMatchObject({ price: 89, agentHoursLimit: 40, popular: true, contactSales: false, terosModel: true })
    expect(growth.highlights).toEqual(['40h'])
    const starter = res.plans.find((p: any) => p.planId === 'plan_starter')
    expect(starter.postBetaPrice).toBe(9)
    expect(res.plans.find((p: any) => p.planId === 'plan_hidden')).toBeUndefined()
  })
})

describe('billing.get-subscription', () => {
  test('null when the user has no active sub', async () => {
    const db = new InMemoryDb()
    seedPlans(db)
    const res = await createGetSubscriptionHandler(db as any)(ctx('u1'), {})
    expect(res.subscription).toBeNull()
  })

  test('shapes the active sub with effective limit incl. boost + resolved scheduled plan', async () => {
    const db = new InMemoryDb()
    seedPlans(db)
    seedActiveSub(db, { scheduledPlanChange: { planId: 'plan_starter', scheduledAt: SCHEDULED_AT } })
    db.seed('billing_hour_boosts', [
      { _id: 'b1', userId: 'u1', subscriptionId: 'sub1', hours: 20, status: 'active', periodStart: PERIOD_START, periodEnd: PERIOD_END, grantedBy: 'admin', accessRequestId: 'r1' },
    ])
    const res = await createGetSubscriptionHandler(db as any)(ctx('u1'), {})
    const s = res.subscription!
    expect(s.planId).toBe('plan_growth')
    expect(s.planName).toBe('Growth')
    expect(s.price).toBe(89)
    expect(s.boostHours).toBe(20)
    expect(s.agentHoursLimit).toBe(60) // 40 base + 20 boost
    expect(s.agentHoursUsed).toBe(12)
    expect(s.currentPeriodEnd).toBe(PERIOD_END.toISOString())
    expect(s.scheduledPlanChange).toEqual({ planId: 'plan_starter', planName: 'Starter', scheduledAt: SCHEDULED_AT.toISOString() })
  })
})

describe('billing.get-invoices', () => {
  test('returns the user\'s invoices, most-recent first, shaped', async () => {
    const db = new InMemoryDb()
    db.seed('billing_invoices', [
      { _id: 'inv_old', userId: 'u1', amount: 89, currency: 'EUR', status: 'paid', invoiceNumber: 'T-1', periodStart: D('2026-05-01'), periodEnd: D('2026-06-01'), hostedInvoiceUrl: 'https://h/1', invoicePdfUrl: null, createdAt: D('2026-05-01') },
      { _id: 'inv_new', userId: 'u1', amount: 89, currency: 'EUR', status: 'pending', invoiceNumber: null, periodStart: D('2026-06-01'), periodEnd: D('2026-07-01'), createdAt: D('2026-06-01') },
      { _id: 'inv_other', userId: 'u2', amount: 1, currency: 'EUR', status: 'paid', invoiceNumber: 'X', periodStart: D('2026-06-01'), periodEnd: D('2026-07-01'), createdAt: D('2026-06-02') },
    ])
    const res = await createGetInvoicesHandler(db as any)(ctx('u1'), {})
    expect(res.invoices.map((i: any) => i.id)).toEqual(['inv_new', 'inv_old']) // recent first, u2 excluded
    expect(res.invoices[1]).toMatchObject({ id: 'inv_old', invoiceNumber: 'T-1', amount: 89, status: 'paid', hostedInvoiceUrl: 'https://h/1', invoicePdfUrl: null })
  })
})

describe('billing.change-plan', () => {
  const now = () => new Date()

  test('upgrade is immediate: new active sub, hours reset', async () => {
    const db = new InMemoryDb()
    seedPlans(db)
    seedActiveSub(db) // on Growth (€89)
    const res = await createChangePlanHandler(db as any, null)(ctx('u1'), { planId: 'plan_pro' }) // €179
    expect(res.kind).toBe('upgraded')
    expect(res.subscription!.planId).toBe('plan_pro')
    expect(res.subscription!.agentHoursUsed).toBe(0) // fresh hours
    // old sub closed
    const old = await db.collection('billing_subscriptions').findOne({ _id: 'sub1' })
    expect(old!.status).toBe('ended')
  })

  test('downgrade is deferred: sub stays, scheduledPlanChange set', async () => {
    const db = new InMemoryDb()
    seedPlans(db)
    seedActiveSub(db, { planId: 'plan_pro', customPrice: null }) // on Pro (€179)
    const res = await createChangePlanHandler(db as any, null)(ctx('u1'), { planId: 'plan_growth' }) // €89
    expect(res.kind).toBe('downgrade_scheduled')
    expect(res.subscription!.planId).toBe('plan_pro') // tier kept until the cut
    expect(res.subscription!.scheduledPlanChange).toMatchObject({ planId: 'plan_growth', planName: 'Growth' })
  })

  test('rejects same plan, contact-sales plan, missing plan, no sub', async () => {
    const db = new InMemoryDb()
    seedPlans(db)
    seedActiveSub(db) // Growth
    const h = createChangePlanHandler(db as any, null)
    await expect(h(ctx('u1'), { planId: 'plan_growth' })).rejects.toThrow(/already on this plan/i)
    await expect(h(ctx('u1'), { planId: 'plan_enterprise' })).rejects.toThrow(/contact sales/i)
    await expect(h(ctx('u1'), { planId: 'plan_nope' })).rejects.toThrow(/not found/i)
    await expect(h(ctx('u_none'), { planId: 'plan_pro' })).rejects.toThrow(/no active subscription/i)
  })
})
