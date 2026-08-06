/**
 * Regression tests for the agent-hours hard gate (FASE 0c).
 *
 * assertHoursAvailable throws HoursExhaustedError when a Teros-model user has
 * consumed their period allowance, and is a no-op otherwise. These guard the
 * "hard block at the limit" decision (#1).
 *
 * MUST BITE: removing the `used >= limit` check, or ignoring the custom
 * override, turns the relevant assertions red.
 */

import { describe, expect, it } from 'bun:test'
import { boostsCollectionFake } from './_billing-fakes'
import {
  BillingGateService,
  HoursExhaustedError,
  NoActiveSubscriptionError,
} from '../../src/services/billing-gate'

interface Plan {
  _id: string
  name: string
  displayName: string
  agentHoursLimit: number
  features: { terosModel: boolean; byok: boolean; maxWorkspaces: number; prioritySupport: boolean }
}

interface Sub {
  userId: string
  planId: string
  status: string
  agentHoursUsed: number
  customAgentHoursLimit: number | null
  currentPeriodEnd: Date
}

const PLANS: Record<string, Plan> = {
  plan_basic: {
    _id: 'plan_basic',
    name: 'basic',
    displayName: 'Basic',
    agentHoursLimit: 0,
    features: { terosModel: false, byok: true, maxWorkspaces: -1, prioritySupport: false },
  },
  plan_pro: {
    _id: 'plan_pro',
    name: 'pro',
    displayName: 'Pro',
    agentHoursLimit: 80,
    features: { terosModel: true, byok: true, maxWorkspaces: -1, prioritySupport: false },
  },
}

function makeDb(subs: Sub[], boosts: any[] = []) {
  return {
    collection(name: string) {
      if (name === 'billing_subscriptions') {
        return {
          async findOne(f: any) {
            // Mirror getActiveSubscription: honour the status filter, so a paused /
            // past_due sub is NOT returned for a status:'active' lookup.
            return (
              subs.find(
                (s) => s.userId === f.userId && (f.status === undefined || s.status === f.status),
              ) ?? null
            )
          },
        }
      }
      if (name === 'billing_plans') {
        return { async findOne(f: any) { return PLANS[f._id] ?? null } }
      }
      if (name === 'teros_provider_configs') {
        return { async findOne() { return null } }
      }
      if (name === 'billing_hour_boosts') {
        return boostsCollectionFake(boosts)
      }
      return { async findOne() { return null } }
    },
  } as any
}

function gate(subs: Sub[], boosts: any[] = []) {
  return new BillingGateService(makeDb(subs, boosts))
}

function sub(over: Partial<Sub>): Sub {
  return {
    userId: 'u',
    planId: 'plan_pro',
    status: 'active',
    agentHoursUsed: 0,
    customAgentHoursLimit: null,
    currentPeriodEnd: new Date('2026-07-01Z'),
    ...over,
  }
}

describe('BillingGateService.assertHoursAvailable (hard block)', () => {
  it('throws HoursExhaustedError when a Pro user is exactly at the limit', async () => {
    const g = gate([sub({ agentHoursUsed: 80 })])
    let thrown: unknown
    try {
      await g.assertHoursAvailable('u')
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(HoursExhaustedError)
    expect((thrown as HoursExhaustedError).limit).toBe(80)
    expect((thrown as HoursExhaustedError).used).toBe(80)
    // Carrier (TER-596 I4): the block CTA needs the readable plan name + reset
    // date, not just the slug tier.
    expect((thrown as HoursExhaustedError).planName).toBe('Pro')
    expect((thrown as HoursExhaustedError).periodEnd).toBe('2026-07-01T00:00:00.000Z')
  })

  it('throws when over the limit', async () => {
    const g = gate([sub({ agentHoursUsed: 95.5 })])
    await expect(g.assertHoursAvailable('u')).rejects.toBeInstanceOf(HoursExhaustedError)
  })

  it('does NOT throw when under the limit', async () => {
    const g = gate([sub({ agentHoursUsed: 79.9 })])
    await expect(g.assertHoursAvailable('u')).resolves.toBeUndefined()
  })

  it('respects a custom override below the plan limit', async () => {
    // Plan allows 80h but this user is capped at 10h; used 10 → blocked.
    const g = gate([sub({ agentHoursUsed: 10, customAgentHoursLimit: 10 })])
    await expect(g.assertHoursAvailable('u')).rejects.toBeInstanceOf(HoursExhaustedError)
  })

  it('is a no-op for a non-Teros plan (tier gate handles those)', async () => {
    const g = gate([sub({ planId: 'plan_basic', agentHoursUsed: 999 })])
    await expect(g.assertHoursAvailable('u')).resolves.toBeUndefined()
  })

  it('BLOCKS with NO_ACTIVE_SUBSCRIPTION when the user has no subscription at all (TER-621)', async () => {
    // Without an active sub there is no metered allowance; serving the Teros model
    // here was a free-unlimited hole. assertHoursAvailable is only reached for the
    // resolved-as-teros path, so this cuts off Teros, not BYOK.
    const g = gate([])
    await expect(g.assertHoursAvailable('nobody')).rejects.toBeInstanceOf(NoActiveSubscriptionError)
  })

  it('BLOCKS a PAUSED / past_due account (no active sub) instead of serving Teros unmetered (TER-621)', async () => {
    // The real trigger: an admin pauses the account (or dunning marks it past_due).
    // getActiveSubscription stops seeing it → the old gate no-op'd → unlimited Teros.
    const paused = gate([sub({ status: 'paused', agentHoursUsed: 999 })])
    await expect(paused.assertHoursAvailable('u')).rejects.toBeInstanceOf(NoActiveSubscriptionError)
    const pastDue = gate([sub({ status: 'past_due', agentHoursUsed: 999 })])
    await expect(pastDue.assertHoursAvailable('u')).rejects.toBeInstanceOf(NoActiveSubscriptionError)
    // MUST BITE: reverting `if (!features) throw` to `return` lets a paused account
    // run the Teros model with no limit → both resolve instead of rejecting.
  })
})

// Active boosts raise the effective limit (FASE 6e). The window is wide so it
// contains the real `new Date()` the gate uses.
function activeBoost(over: Record<string, any> = {}) {
  return {
    _id: crypto.randomUUID(),
    subscriptionId: 'sub1',
    userId: 'u',
    hours: 20,
    periodStart: new Date('2020-01-01Z'),
    periodEnd: new Date('2030-01-01Z'),
    status: 'active',
    grantedBy: 'admin',
    accessRequestId: crypto.randomUUID(),
    createdAt: new Date('2020-01-01Z'),
    ...over,
  }
}

describe('BillingGateService — boosts raise the effective limit (FASE 6e)', () => {
  it('does NOT throw when an active boost lifts the user above their usage', async () => {
    // Used 80 of a base-80 plan: blocked without a boost, but a +20 boost makes
    // the effective limit 100, so the gate lets them through.
    const g = gate([sub({ _id: 'sub1', agentHoursUsed: 80 })], [activeBoost({ hours: 20 })])
    await expect(g.assertHoursAvailable('u')).resolves.toBeUndefined()
  })

  it('still throws once usage reaches the boosted limit', async () => {
    const g = gate([sub({ _id: 'sub1', agentHoursUsed: 100 })], [activeBoost({ hours: 20 })])
    let thrown: unknown
    try {
      await g.assertHoursAvailable('u')
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(HoursExhaustedError)
    expect((thrown as HoursExhaustedError).limit).toBe(100)
    expect((thrown as HoursExhaustedError).used).toBe(100)
  })

  it('an expired boost does NOT count toward the limit', async () => {
    const g = gate([sub({ _id: 'sub1', agentHoursUsed: 80 })], [activeBoost({ status: 'expired' })])
    await expect(g.assertHoursAvailable('u')).rejects.toBeInstanceOf(HoursExhaustedError)
  })

  it('getSubscriptionFeatures exposes the boosted limit and the boost component', async () => {
    const g = gate([sub({ _id: 'sub1', agentHoursUsed: 50 })], [activeBoost({ hours: 20 }), activeBoost({ hours: 5 })])
    const f = await g.getSubscriptionFeatures('u')
    expect(f).toEqual({
      tier: 'pro',
      planName: 'Pro',
      terosModel: true,
      byok: true,
      maxWorkspaces: -1,
      prioritySupport: false,
      agentHoursLimit: 105,
      boostHours: 25,
      agentHoursUsed: 50,
      currentPeriodEnd: '2026-07-01T00:00:00.000Z',
    })
  })
})
