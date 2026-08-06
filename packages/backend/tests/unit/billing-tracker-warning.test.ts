/**
 * FASE 6a — the agent-hours-tracker emits the 80%-usage warning.
 *
 * The warning fires once per period when consumption crosses 80% of the
 * EFFECTIVE limit (base + active boosts), via PubSub. Each test is
 * mutation-checked against agent-hours-tracker.ts:
 *   - drop the threshold guard → the "under 80%" test emits → red.
 *   - drop the warned80At claim/guard → the "already warned" test re-emits → red.
 *   - drop the boost from the effective limit → the "boost raises the bar" test
 *     emits when it must not → red (the crown mutation).
 */

import { describe, expect, it } from 'bun:test'
import { AgentHoursTracker } from '../../src/services/agent-hours-tracker'
import { boostsCollectionFake } from './_billing-fakes'

const stubLogger = { info() {}, warn() {}, error() {}, debug() {} } as any

const HOUR_MS = 3_600_000
const PERIOD_END = new Date('2026-07-01T00:00:00Z')

function makeCursor<T>(items: T[]) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        next: () =>
          Promise.resolve(i < items.length ? { value: items[i++], done: false } : { value: undefined, done: true }),
      }
    },
    async close() {},
  }
}

function makeSpy() {
  const events: Array<{ userId: string; event: any }> = []
  return {
    events,
    broadcastToUser(userId: string, event: Record<string, unknown>) {
      events.push({ userId, event })
    },
  }
}

/** One sub, one rollup adding `addHours`. Plan pro (terosModel, 80h base). */
function makeDb(sub: any, addHours: number, boosts: any[] = []) {
  const rollup = {
    _id: 'r1',
    groupKey: { userId: sub.userId },
    hourBucket: new Date('2026-06-15T00:00:00Z'),
    userActiveMs: addHours * HOUR_MS,
  }
  return {
    collection(name: string) {
      if (name === 'agent_usage_rollups_user_hourly') {
        return {
          aggregate(pipeline: any[]) {
            const m = pipeline[0].$match
            const rows = m['groupKey.userId'] === rollup.groupKey.userId && rollup.hourBucket > m.hourBucket.$gt ? [rollup] : []
            return {
              async toArray() {
                if (rows.length === 0) return []
                return [
                  {
                    totalMs: rows.reduce((a, r) => a + r.userActiveMs, 0),
                    maxHourBucket: rows[0].hourBucket,
                    count: rows.length,
                    rollupIds: rows.map((r) => r._id),
                  },
                ]
              },
            }
          },
        }
      }
      if (name === 'billing_subscriptions') {
        return {
          find() {
            return makeCursor([sub])
          },
          async updateOne(filter: any, update: any) {
            // CAS $inc (by userId, with the lastBilledHourBucket $or guard).
            if (filter.userId) {
              if (sub.userId !== filter.userId || sub.status !== 'active') return { matchedCount: 0 }
              const maxHour: Date = filter.$or[0].lastBilledHourBucket.$lt
              if (!(sub.lastBilledHourBucket == null || sub.lastBilledHourBucket < maxHour)) return { matchedCount: 0 }
              if (update.$inc?.agentHoursUsed) sub.agentHoursUsed = (sub.agentHoursUsed ?? 0) + update.$inc.agentHoursUsed
              if (update.$set) Object.assign(sub, update.$set)
              return { matchedCount: 1 }
            }
            // warned80At claim (by _id, guard warned80At null/absent).
            if (sub._id !== filter._id) return { matchedCount: 0 }
            // Simulate another instance winning the atomic claim concurrently.
            if (sub._claimLost) return { matchedCount: 0 }
            const w = sub.warned80At
            if (filter.$or && !(w === null || w === undefined)) return { matchedCount: 0 }
            if (update.$set) Object.assign(sub, update.$set)
            return { matchedCount: 1 }
          },
        }
      }
      if (name === 'billing_hour_ledger') {
        return { async insertOne() { return { insertedId: 'led' } } }
      }
      if (name === 'billing_plans') {
        return {
          async findOne(f: any) {
            if (f._id !== 'plan_pro') return null
            return { _id: 'plan_pro', name: 'pro', agentHoursLimit: 80, features: { terosModel: true } }
          },
        }
      }
      if (name === 'billing_hour_boosts') {
        return boostsCollectionFake(boosts)
      }
      return null as any
    },
  } as any
}

function proSub(over: Record<string, any> = {}) {
  return {
    _id: 'sub1',
    userId: 'u',
    planId: 'plan_pro',
    status: 'active',
    agentHoursUsed: 0,
    customAgentHoursLimit: null,
    currentPeriodEnd: PERIOD_END,
    ...over,
  }
}

function tracker(db: any, spy: any) {
  return new AgentHoursTracker(db, stubLogger, null, undefined, spy)
}

describe('AgentHoursTracker — 80% usage warning (FASE 6a)', () => {
  it('emits exactly one warning with the exact payload when usage crosses 80%', async () => {
    const sub = proSub()
    const spy = makeSpy()
    await tracker(makeDb(sub, 65), spy).runOnce() // 65 >= 0.8 * 80 = 64

    expect(spy.events).toHaveLength(1)
    expect(spy.events[0]).toEqual({
      userId: 'u',
      event: {
        type: 'billing.usage-warning',
        userId: 'u',
        used: 65,
        limit: 80,
        boostHours: 0,
        threshold: 0.8,
        tier: 'pro',
        periodEnd: PERIOD_END.toISOString(),
      },
    })
    expect(sub.warned80At).toBeInstanceOf(Date)
  })

  it('does NOT warn when usage stays below 80%', async () => {
    const sub = proSub()
    const spy = makeSpy()
    await tracker(makeDb(sub, 50), spy).runOnce() // 50 < 64

    expect(spy.events).toHaveLength(0)
    expect(sub.warned80At).toBeUndefined()
  })

  it('does NOT re-warn when already warned this period', async () => {
    const sub = proSub({ warned80At: new Date('2026-06-10Z') })
    const spy = makeSpy()
    await tracker(makeDb(sub, 70), spy).runOnce()

    expect(spy.events).toHaveLength(0)
  })

  it('a boost raises the threshold so a mid-base-range usage does NOT warn (crown)', async () => {
    // Base 80 → 80% is 64. With a +40 boost the effective limit is 120 → 80% is
    // 96. Adding 70h is past the base threshold but below the boosted one.
    const sub = proSub()
    const spy = makeSpy()
    const boost = {
      _id: 'b1', subscriptionId: 'sub1', userId: 'u', hours: 40,
      periodStart: new Date('2020-01-01Z'), periodEnd: new Date('2030-01-01Z'),
      status: 'active', grantedBy: 'a', accessRequestId: 'ar1', createdAt: new Date('2020-01-01Z'),
    }
    await tracker(makeDb(sub, 70), spy).runOnce()
    await tracker(makeDb(proSub(), 70, [boost]), spy).runOnce()

    // First run (no boost) warned; second (boosted) did not → exactly one event.
    expect(spy.events).toHaveLength(1)
    expect(spy.events[0].event.limit).toBe(80)
  })

  it('does NOT emit when it loses the atomic warned80At claim (concurrency)', async () => {
    // warned80At is still unset on the read doc, but another instance claimed it
    // first → the atomic updateOne matches nothing. The claim, not the early
    // guard, is the real idempotency authority under multi-instance.
    const sub = proSub({ _claimLost: true })
    const spy = makeSpy()
    await tracker(makeDb(sub, 65), spy).runOnce()
    expect(spy.events).toHaveLength(0)
  })

  it('is a no-op when no publisher is wired (warnings disabled)', async () => {
    const sub = proSub()
    await new AgentHoursTracker(makeDb(sub, 65), stubLogger, null, undefined, null).runOnce()
    expect(sub.warned80At).toBeUndefined() // never claimed
  })

  it('does NOT warn on a non-Teros plan', async () => {
    const sub = proSub({ planId: 'plan_basic' })
    const spy = makeSpy()
    // plan lookup returns null for non-pro → unmetered → no warning.
    await tracker(makeDb(sub, 999), spy).runOnce()
    expect(spy.events).toHaveLength(0)
  })
})
