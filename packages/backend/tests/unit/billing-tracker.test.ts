/**
 * Regression tests for AgentHoursTracker — the per-user cursor fix that kills
 * the agentHoursUsed double-count (FASE 0b).
 *
 * The bug: the tracker used a GLOBAL cutoff (min lastBilledHourBucket across all
 * active subs) and re-summed each user's rollups from that global point, so a
 * user whose cursor was ahead of the laggiest sub got hours already billed in
 * prior ticks re-added on every run.
 *
 * These tests MUST BITE: reverting the tracker to a global cutoff turns the
 * "double count" and "disjoint cursors" assertions red (see comments).
 *
 * Hermetic in-memory Mongo fake (mutates subscriptions so cumulative
 * agentHoursUsed across ticks is observable), same style as
 * agent-usage-rollup-job.test.ts.
 */

import { describe, expect, it } from 'bun:test'
import { AgentHoursTracker } from '../../src/services/agent-hours-tracker'

const stubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => stubLogger,
} as any

const HOUR_MS = 3_600_000

/** Hour bucket as a Date: hb(5) = 2026-01-01T05:00:00Z */
function hb(h: number): Date {
  return new Date(Date.UTC(2026, 0, 1, h))
}

interface Sub {
  userId: string
  status: string
  lastBilledHourBucket?: Date
  agentHoursUsed: number
  updatedAt?: Date
  resetting?: boolean
}

interface Rollup {
  groupKey: { userId: string }
  hourBucket: Date
  userActiveMs: number
}

/** One rollup of exactly one active hour for a user at hour bucket h. */
function roll(userId: string, h: number): Rollup {
  return { groupKey: { userId }, hourBucket: hb(h), userActiveMs: HOUR_MS }
}

function makeCursor<T>(items: T[]) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        next() {
          if (i < items.length) return Promise.resolve({ value: items[i++], done: false })
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
    async close() {},
  }
}

/**
 * In-memory fake. `subs` are mutated by updateOne so cumulative billing across
 * ticks is observable. `rollups` is immutable (TTL collection, never purged).
 */
function makeDb(subs: Sub[], rollups: Rollup[]) {
  return {
    collection(name: string) {
      if (name === 'billing_subscriptions') {
        return {
          find(filter: any) {
            const matches = subs.filter((s) => {
              if (s.status !== filter.status) return false
              // Honor the resetting:{$ne:true} guard (mutual exclusion with reset).
              if (filter.resetting && '$ne' in filter.resetting) {
                return s.resetting !== filter.resetting.$ne
              }
              return true
            })
            return makeCursor(matches)
          },
          async updateOne(filter: any, update: any) {
            const sub = subs.find((s) => s.userId === filter.userId && s.status === 'active')
            if (!sub) return { matchedCount: 0 }
            // Replicate the atomic guard: advance only if our cursor is behind
            // the max hour being committed (or absent).
            const maxHour: Date = filter.$or[0].lastBilledHourBucket.$lt
            const guardOk =
              sub.lastBilledHourBucket == null || sub.lastBilledHourBucket < maxHour
            if (!guardOk) return { matchedCount: 0 }
            sub.agentHoursUsed = (sub.agentHoursUsed ?? 0) + update.$inc.agentHoursUsed
            sub.lastBilledHourBucket = update.$set.lastBilledHourBucket
            sub.updatedAt = update.$set.updatedAt
            return { matchedCount: 1 }
          },
        }
      }
      if (name === 'agent_usage_rollups_user_hourly') {
        return {
          aggregate(pipeline: any[]) {
            const match = pipeline[0].$match
            const uid: string = match['groupKey.userId']
            const gt: Date = match.hourBucket.$gt
            const rows = rollups.filter((r) => r.groupKey.userId === uid && r.hourBucket > gt)
            return {
              async toArray() {
                if (rows.length === 0) return []
                const totalMs = rows.reduce((a, r) => a + r.userActiveMs, 0)
                const maxHourBucket = rows.reduce(
                  (m, r) => (r.hourBucket > m ? r.hourBucket : m),
                  rows[0].hourBucket,
                )
                return [{ totalMs, maxHourBucket, count: rows.length, rollupIds: [] }]
              },
            }
          },
        }
      }
      if (name === 'billing_hour_ledger') {
        // The per-user cursor tests don't assert on the ledger; accept writes.
        return { async insertOne(_doc: any) { return { insertedId: 'x' } } }
      }
      return null as any
    },
  } as any
}

describe('AgentHoursTracker — per-user cursor (anti double-count)', () => {
  it('bills each sub from ITS OWN cursor, not a global min cutoff', async () => {
    // A is ahead (already billed hours 1-5); B has never been billed.
    const subA: Sub = { userId: 'A', status: 'active', lastBilledHourBucket: hb(5), agentHoursUsed: 5 }
    const subB: Sub = { userId: 'B', status: 'active', agentHoursUsed: 0 }
    const rollups = [
      ...Array.from({ length: 10 }, (_, i) => roll('A', i + 1)), // hours 1..10
      ...Array.from({ length: 10 }, (_, i) => roll('B', i + 1)), // hours 1..10
    ]
    const tracker = new AgentHoursTracker(makeDb([subA, subB], rollups), stubLogger, null)

    await tracker.runOnce()

    // A: 5 prior + hours 6..10 = 10. B: hours 1..10 = 10.
    // With the OLD global cutoff (min = hb(5)), B would only get hours 6..10 = 5.
    expect(subA.agentHoursUsed).toBe(10)
    expect(subB.agentHoursUsed).toBe(10)
    expect(subA.lastBilledHourBucket).toEqual(hb(10))
    expect(subB.lastBilledHourBucket).toEqual(hb(10))
  })

  it('does NOT re-sum already-billed hours when a laggy sub gets new activity', async () => {
    // The classic double-count: after tick 1, both get new disjoint activity.
    const subA: Sub = { userId: 'A', status: 'active', agentHoursUsed: 0 }
    const subB: Sub = { userId: 'B', status: 'active', agentHoursUsed: 0 }
    const rollups: Rollup[] = [roll('A', 1), roll('A', 2), roll('B', 1), roll('B', 2), roll('B', 3), roll('B', 4), roll('B', 5)]
    const db = makeDb([subA, subB], rollups)
    const tracker = new AgentHoursTracker(db, stubLogger, null)

    await tracker.runOnce() // A -> 2h (cursor h2), B -> 5h (cursor h5)
    expect(subA.agentHoursUsed).toBe(2)
    expect(subB.agentHoursUsed).toBe(5)

    // New disjoint activity: A at h3, B at h6.
    rollups.push(roll('A', 3), roll('B', 6))
    await tracker.runOnce()

    // Per-user: A +1 (h3) = 3, B +1 (h6) = 6.
    // OLD global cutoff (min = h2) would re-sum B's h3,h4,h5 → B = 9. BITE.
    expect(subA.agentHoursUsed).toBe(3)
    expect(subB.agentHoursUsed).toBe(6)
  })

  it('is idempotent: a repeated tick with no new rollups changes nothing', async () => {
    const subA: Sub = { userId: 'A', status: 'active', agentHoursUsed: 0 }
    const rollups = [roll('A', 1), roll('A', 2), roll('A', 3)]
    const tracker = new AgentHoursTracker(makeDb([subA], rollups), stubLogger, null)

    await tracker.runOnce()
    expect(subA.agentHoursUsed).toBe(3)
    const cursorAfterFirst = subA.lastBilledHourBucket

    await tracker.runOnce() // no new rollups
    expect(subA.agentHoursUsed).toBe(3)
    expect(subA.lastBilledHourBucket).toEqual(cursorAfterFirst!)
  })

  it('skips subs the reset-cron is mid-rewriting (resetting:true)', async () => {
    // Mutual exclusion: while the reset zeroes a sub's period, the tracker must
    // not $inc onto it (those hours would be lost or land on the wrong period).
    const resetting: Sub = { userId: 'R', status: 'active', agentHoursUsed: 0, resetting: true }
    const rollups = [roll('R', 1), roll('R', 2)]
    const tracker = new AgentHoursTracker(makeDb([resetting], rollups), stubLogger, null)

    const result = await tracker.runOnce()

    // MUST BITE: dropping `resetting:{$ne:true}` from the find filter bills R → 2h.
    expect(resetting.agentHoursUsed).toBe(0)
    expect(result.usersBilled).toBe(0)
  })

  it('skips paused/cancelled subs entirely', async () => {
    const paused: Sub = { userId: 'P', status: 'paused', agentHoursUsed: 0 }
    const rollups = [roll('P', 1), roll('P', 2)]
    const tracker = new AgentHoursTracker(makeDb([paused], rollups), stubLogger, null)

    const result = await tracker.runOnce()
    expect(paused.agentHoursUsed).toBe(0)
    expect(result.usersBilled).toBe(0)
  })
})
