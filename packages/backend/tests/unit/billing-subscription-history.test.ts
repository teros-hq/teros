/**
 * Subscription history — plan change / cancellation / edit (FASE 1f).
 *
 * Plan change is immediate WITH history (decision #6): close the active sub,
 * open a new active one on the new plan anchored to day+1. Cancellation is
 * deferred (decision #7): flag cancelAtPeriodEnd, keep the tier until period end.
 * At most one active sub per user (the in-memory fake rejects a second active
 * insert, mirroring the partial unique index billing_sub_one_active).
 */

import { describe, expect, it } from 'bun:test'
import { createUpdateBillingSubscriptionHandler } from '../../src/handlers/domains/admin/update-billing-subscription'

const PLANS: Record<string, any> = {
  plan_basic: { _id: 'plan_basic', name: 'basic', displayName: 'Essential', price: 0 },
  plan_pro: { _id: 'plan_pro', name: 'pro', displayName: 'Pro', price: 89 },
  plan_max: { _id: 'plan_max', name: 'max', displayName: 'Max', price: 179 },
}

function makeUserService() {
  return {
    getByUserId: async (id: string) => {
      if (id === 'admin1') return { userId: 'admin1', role: 'admin' }
      if (id === 'u') return { userId: 'u', role: 'user' }
      return null
    },
  } as any
}

function activeSub(over: any = {}) {
  const now = new Date('2026-03-15T00:00:00Z')
  return {
    _id: 'sub_initial',
    userId: 'u',
    planId: 'plan_basic',
    customAgentHoursLimit: null,
    customPrice: null,
    customPriceNote: null,
    agentHoursUsed: 0,
    overageHours: 0,
    currentPeriodStart: now,
    currentPeriodEnd: new Date('2026-04-15T00:00:00Z'),
    status: 'active',
    startDate: now,
    endDate: null,
    paymentMethod: 'manual',
    billingNotes: '',
    ...over,
  }
}

function makeDb(subs: any[]) {
  return {
    collection(name: string) {
      if (name === 'billing_subscriptions') {
        return {
          async findOne(f: any) {
            if (f._id) return subs.find((s) => s._id === f._id) ?? null
            return (
              subs.find(
                (s) => s.userId === f.userId && (f.status === undefined || s.status === f.status),
              ) ?? null
            )
          },
          async insertOne(doc: any) {
            // Mirror the partial unique index: one active sub per user.
            if (doc.status === 'active' && subs.some((s) => s.userId === doc.userId && s.status === 'active')) {
              throw new Error('E11000 duplicate key: billing_sub_one_active')
            }
            subs.push(doc)
            return { insertedId: doc._id }
          },
          async updateOne(f: any, u: any) {
            const s = subs.find((x) => x._id === f._id)
            if (!s) return { matchedCount: 0 }
            Object.assign(s, u.$set)
            return { matchedCount: 1 }
          },
        }
      }
      if (name === 'billing_plans') return { async findOne(f: any) { return PLANS[f._id] ?? null } }
      if (name === 'billing_invoices') return { async findOne() { return null } }
      if (name === 'teros_provider_configs') return { async findOne() { return null } }
      if (name === 'billing_teams') return { async findOne() { return null } }
      return null as any
    },
  } as any
}

const ctx = { userId: 'admin1' } as any

describe('billing subscription history', () => {
  it('two consecutive plan changes leave exactly one active + N ended', async () => {
    const subs = [activeSub()]
    const handler = createUpdateBillingSubscriptionHandler(makeUserService(), makeDb(subs))

    await handler(ctx, { targetUserId: 'u', planId: 'plan_pro' })
    await handler(ctx, { targetUserId: 'u', planId: 'plan_max' })

    const active = subs.filter((s) => s.status === 'active')
    const ended = subs.filter((s) => s.status === 'ended')
    // MUST BITE: an in-place `$set planId` (old behavior) leaves 1 sub, 0 ended.
    expect(active).toHaveLength(1)
    expect(active[0].planId).toBe('plan_max')
    expect(ended).toHaveLength(2)
    expect(ended.map((s) => s.planId).sort()).toEqual(['plan_basic', 'plan_pro'])
    // Ended subs carry an endDate; the active one does not.
    expect(ended.every((s) => s.endDate instanceof Date)).toBe(true)
    expect(active[0].endDate).toBeNull()
  })

  it('an UPGRADE is immediate (start=now) and keeps the ORIGINAL cut (decision A)', async () => {
    // Original cut in the future so the new sub adopts it (not now+1 month).
    const originalCut = new Date(Date.now() + 20 * 86_400_000)
    const subs = [activeSub({ currentPeriodEnd: originalCut })]
    const handler = createUpdateBillingSubscriptionHandler(makeUserService(), makeDb(subs))

    // plan_basic (€0) → plan_pro (€89): an upgrade.
    await handler(ctx, { targetUserId: 'u', planId: 'plan_pro' })
    const newActive = subs.find((s) => s.status === 'active')!

    // MUST BITE: the old day+1 anchor put currentPeriodStart = startDate + 1 day.
    expect(newActive.currentPeriodStart.getTime()).toBe(newActive.startDate.getTime())
    // MUST BITE: the old behavior set currentPeriodEnd = start + 1 month.
    expect(newActive.currentPeriodEnd.getTime()).toBe(originalCut.getTime())
    // All the new plan's hours, fresh cursor (pre-change hours not re-billed).
    expect(newActive.lastBilledHourBucket).toBeInstanceOf(Date)
    expect(newActive.agentHoursUsed).toBe(0)
  })

  it('an admin DOWNGRADE is IMMEDIATE in both directions (TER-631): flips the plan now, no deferral', async () => {
    const subs = [activeSub({ planId: 'plan_max' })]
    const handler = createUpdateBillingSubscriptionHandler(makeUserService(), makeDb(subs))

    // plan_max (€179) → plan_pro (€89): a downgrade. An ADMIN change is an
    // administrative action and applies NOW — not deferred to the period end like
    // the self-serve billing.change-plan (that left the panel showing "no change").
    const res = await handler(ctx, { targetUserId: 'u', planId: 'plan_pro' })

    const active = subs.filter((s) => s.status === 'active')
    expect(active).toHaveLength(1)
    expect(active[0].planId).toBe('plan_pro') // applied immediately
    expect(active[0].scheduledPlanChange ?? null).toBeNull()
    expect(res.subscription.planId).toBe('plan_pro')
    expect(res.subscription.scheduledPlanChange ?? null).toBeNull()
    // History kept: the old plan_max sub is ended.
    expect(subs.filter((s) => s.status === 'ended').map((s) => s.planId)).toEqual(['plan_max'])
    // MUST BITE: routing the admin path back through applyPlanChange defers the
    // downgrade → planId stays plan_max + scheduledPlanChange set → red.
  })

  it('cancellation is deferred: flags cancelAtPeriodEnd, keeps the sub active', async () => {
    const subs = [activeSub({ planId: 'plan_pro' })]
    const handler = createUpdateBillingSubscriptionHandler(makeUserService(), makeDb(subs))

    const res = await handler(ctx, { targetUserId: 'u', status: 'cancelled' })

    const s = subs[0]
    // MUST BITE: setting status:'cancelled' (immediate downgrade) flips this.
    expect(s.status).toBe('active')
    expect(s.cancelAtPeriodEnd).toBe(true)
    expect(res.subscription.cancelAtPeriodEnd).toBe(true)
    expect(subs.filter((x) => x.status === 'active')).toHaveLength(1)
  })

  it('resuming (status:active) clears a pending cancellation', async () => {
    const subs = [activeSub({ planId: 'plan_pro', cancelAtPeriodEnd: true })]
    const handler = createUpdateBillingSubscriptionHandler(makeUserService(), makeDb(subs))

    await handler(ctx, { targetUserId: 'u', status: 'active' })

    expect(subs[0].cancelAtPeriodEnd).toBe(false)
    expect(subs[0].status).toBe('active')
  })

  it('a plain edit (price) does NOT spawn history', async () => {
    const subs = [activeSub({ planId: 'plan_pro' })]
    const handler = createUpdateBillingSubscriptionHandler(makeUserService(), makeDb(subs))

    await handler(ctx, { targetUserId: 'u', customPrice: 50 })

    expect(subs).toHaveLength(1)
    expect(subs[0].customPrice).toBe(50)
    expect(subs[0].status).toBe('active')
  })
})
