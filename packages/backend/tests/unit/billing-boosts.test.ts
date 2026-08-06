/**
 * FASE 6 — getEffectiveLimit(boost) + getActiveBoostHours.
 *
 * These two functions are the heart of the boost mechanism: the effective limit
 * MUST include active boosts, and "active" MUST be scoped to status + the
 * period window. Each test is mutation-checked: reverting the corresponding
 * line in models/billing.ts turns it red.
 */

import { describe, expect, it } from 'bun:test'
import { getActiveBoostHours, getEffectiveLimit } from '../../src/models/billing'
import { InMemoryDb } from './_stripe-test-helpers'

const plan = { agentHoursLimit: 80 }

function boost(over: Record<string, any> = {}) {
  return {
    _id: crypto.randomUUID(),
    userId: 'u',
    subscriptionId: 'sub1',
    hours: 10,
    periodStart: new Date('2026-06-01T00:00:00Z'),
    periodEnd: new Date('2026-07-01T00:00:00Z'),
    status: 'active' as const,
    grantedBy: 'admin',
    accessRequestId: crypto.randomUUID(),
    createdAt: new Date('2026-06-10T00:00:00Z'),
    ...over,
  }
}

const NOW = new Date('2026-06-15T00:00:00Z')

describe('getEffectiveLimit — boost is additive', () => {
  it('returns the base limit when boostHours is omitted (legacy callers)', () => {
    expect(getEffectiveLimit({ customAgentHoursLimit: null }, plan)).toBe(80)
  })

  it('adds boostHours to the plan default', () => {
    expect(getEffectiveLimit({ customAgentHoursLimit: null }, plan, 25)).toBe(105)
  })

  it('adds boostHours on top of a custom override (not the plan default)', () => {
    expect(getEffectiveLimit({ customAgentHoursLimit: 120 }, plan, 30)).toBe(150)
  })

  it('custom override of 0 is honored (not coalesced to the plan default)', () => {
    // 0 ?? plan would be wrong; ?? keeps 0. With a boost it is exactly the boost.
    expect(getEffectiveLimit({ customAgentHoursLimit: 0 }, plan, 5)).toBe(5)
  })
})

describe('getActiveBoostHours — active + in-window only', () => {
  function dbWith(boosts: any[]) {
    const db = new InMemoryDb()
    db.seed('billing_hour_boosts', boosts)
    return db as any
  }

  it('sums multiple active boosts inside the window', async () => {
    const db = dbWith([boost({ hours: 10 }), boost({ hours: 15 })])
    expect(await getActiveBoostHours(db, 'sub1', NOW)).toBe(25)
  })

  it('returns 0 when there are no boosts', async () => {
    expect(await getActiveBoostHours(dbWith([]), 'sub1', NOW)).toBe(0)
  })

  it('excludes expired and revoked boosts (status filter)', async () => {
    const db = dbWith([
      boost({ hours: 10, status: 'active' }),
      boost({ hours: 99, status: 'expired' }),
      boost({ hours: 99, status: 'revoked' }),
    ])
    expect(await getActiveBoostHours(db, 'sub1', NOW)).toBe(10)
  })

  it('excludes boosts of a different subscription', async () => {
    const db = dbWith([boost({ hours: 10 }), boost({ hours: 99, subscriptionId: 'other' })])
    expect(await getActiveBoostHours(db, 'sub1', NOW)).toBe(10)
  })

  it('excludes a boost whose window already ended (periodEnd <= now)', async () => {
    const db = dbWith([
      boost({ hours: 10 }),
      boost({ hours: 99, periodStart: new Date('2026-04-01Z'), periodEnd: new Date('2026-05-01Z') }),
    ])
    expect(await getActiveBoostHours(db, 'sub1', NOW)).toBe(10)
  })

  it('excludes a boost whose window has not started (periodStart > now)', async () => {
    const db = dbWith([
      boost({ hours: 10 }),
      boost({ hours: 99, periodStart: new Date('2026-08-01Z'), periodEnd: new Date('2026-09-01Z') }),
    ])
    expect(await getActiveBoostHours(db, 'sub1', NOW)).toBe(10)
  })
})
