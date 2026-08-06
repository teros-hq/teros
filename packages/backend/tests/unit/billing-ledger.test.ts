/**
 * Tests for the append-only billing_hour_ledger (FASE 2a).
 *
 * The tracker writes ONE ledger entry per committed range, BEFORE the $inc,
 * keyed uniquely by (subscriptionId, hourBucket). The ledger explains how
 * agentHoursUsed reached its value (the source for admin.get-billing-audit).
 *
 * These tests MUST BITE:
 *   - Removing the ledger insert turns "writes a ledger entry" red.
 *   - Skipping the $inc on a duplicate ledger insert turns "crash-between
 *     recovery" red (agentHoursUsed would under-count).
 *   - Breaking the cursor/cumulative math turns the payload assertions red.
 *
 * Hermetic in-memory Mongo fake, same style as billing-tracker.test.ts, with a
 * billing_hour_ledger collection that enforces the unique index.
 */

import { describe, expect, it } from 'bun:test'
import { MongoServerError } from 'mongodb'
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

function hb(h: number): Date {
  return new Date(Date.UTC(2026, 0, 1, h))
}

interface Sub {
  _id: string
  userId: string
  status: string
  lastBilledHourBucket?: Date
  agentHoursUsed: number
  updatedAt?: Date
  resetting?: boolean
}

interface Rollup {
  _id: string
  groupKey: { userId: string }
  hourBucket: Date
  userActiveMs: number
}

interface LedgerEntry {
  _id: string
  subscriptionId: string
  userId: string
  hourBucket: Date
  fromHourBucket: Date | null
  hoursAdded: number
  cumulative: number
  rollupCount: number
  rollupIds: string[]
  trackerRunId: string
  createdAt: Date
}

function roll(userId: string, h: number): Rollup {
  return { _id: `r_${userId}_${h}`, groupKey: { userId }, hourBucket: hb(h), userActiveMs: HOUR_MS }
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

function dupKeyError(): MongoServerError {
  const err = new MongoServerError({ message: 'E11000 duplicate key' })
  ;(err as any).code = 11000
  return err
}

/**
 * In-memory fake. `subs` mutate on updateOne; `ledger` is the append-only store
 * with a unique (subscriptionId, hourBucket) guard mirroring the real index.
 * `failIncAfterLedger` simulates a crash AFTER the ledger insert but BEFORE the
 * $inc: the updateOne is suppressed exactly once per sub.
 */
function makeDb(
  subs: Sub[],
  rollups: Rollup[],
  ledger: LedgerEntry[],
  opts: { failIncOnce?: Set<string> } = {},
) {
  return {
    collection(name: string) {
      if (name === 'billing_subscriptions') {
        return {
          find(filter: any) {
            const matches = subs.filter((s) => {
              if (s.status !== filter.status) return false
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
            // Simulate a crash between ledger insert and $inc: drop this write once.
            if (opts.failIncOnce?.has(sub._id)) {
              opts.failIncOnce.delete(sub._id)
              return { matchedCount: 0 }
            }
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
                return [{ totalMs, maxHourBucket, count: rows.length, rollupIds: rows.map((r) => r._id) }]
              },
            }
          },
        }
      }
      if (name === 'billing_hour_ledger') {
        return {
          async insertOne(doc: LedgerEntry) {
            // Enforce the unique (subscriptionId, hourBucket) index.
            const dup = ledger.find(
              (e) => e.subscriptionId === doc.subscriptionId && +e.hourBucket === +doc.hourBucket,
            )
            if (dup) throw dupKeyError()
            ledger.push(doc)
            return { insertedId: doc._id }
          },
        }
      }
      return null as any
    },
  } as any
}

describe('billing_hour_ledger — append-only audit trail (FASE 2a)', () => {
  it('writes one ledger entry per commit with the exact payload', async () => {
    const sub: Sub = { _id: 's1', userId: 'A', status: 'active', agentHoursUsed: 0 }
    const rollups = [roll('A', 1), roll('A', 2), roll('A', 3)]
    const ledger: LedgerEntry[] = []
    const tracker = new AgentHoursTracker(makeDb([sub], rollups, ledger), stubLogger, null)

    await tracker.runOnce()

    // BITE: removing the ledger insert leaves this empty.
    expect(ledger.length).toBe(1)
    const entry = ledger[0]
    expect(entry.subscriptionId).toBe('s1')
    expect(entry.userId).toBe('A')
    expect(entry.hourBucket).toEqual(hb(3)) // max bucket = new cursor
    expect(entry.fromHourBucket).toBeNull() // never billed before
    expect(entry.hoursAdded).toBe(3)
    expect(entry.cumulative).toBe(3) // 0 prior + 3
    expect(entry.rollupCount).toBe(3)
    expect(entry.rollupIds).toEqual(['r_A_1', 'r_A_2', 'r_A_3'])
    expect(entry.trackerRunId).toBeString()
    // The $inc still landed.
    expect(sub.agentHoursUsed).toBe(3)
    expect(sub.lastBilledHourBucket).toEqual(hb(3))
  })

  it('records fromHourBucket and cumulative across consecutive commits', async () => {
    const sub: Sub = { _id: 's1', userId: 'A', status: 'active', agentHoursUsed: 0 }
    const rollups = [roll('A', 1), roll('A', 2)]
    const ledger: LedgerEntry[] = []
    const tracker = new AgentHoursTracker(makeDb([sub], rollups, ledger), stubLogger, null)

    await tracker.runOnce() // bucket 1..2
    rollups.push(roll('A', 3), roll('A', 4))
    await tracker.runOnce() // bucket 3..4

    expect(ledger.length).toBe(2)
    expect(ledger[1].fromHourBucket).toEqual(hb(2)) // previous cursor
    expect(ledger[1].hourBucket).toEqual(hb(4))
    expect(ledger[1].hoursAdded).toBe(2)
    expect(ledger[1].cumulative).toBe(4) // 2 prior + 2
  })

  it('is idempotent: a repeated tick with no new rollups adds no ledger entry', async () => {
    const sub: Sub = { _id: 's1', userId: 'A', status: 'active', agentHoursUsed: 0 }
    const rollups = [roll('A', 1), roll('A', 2)]
    const ledger: LedgerEntry[] = []
    const tracker = new AgentHoursTracker(makeDb([sub], rollups, ledger), stubLogger, null)

    await tracker.runOnce()
    await tracker.runOnce() // no new rollups → aggregation count 0 → no entry

    expect(ledger.length).toBe(1)
    expect(sub.agentHoursUsed).toBe(2)
  })

  it('caps rollupIds but keeps rollupCount exact', async () => {
    const sub: Sub = { _id: 's1', userId: 'A', status: 'active', agentHoursUsed: 0 }
    // 600 buckets > LEDGER_MAX_ROLLUP_IDS (500).
    const rollups = Array.from({ length: 600 }, (_, i) => roll('A', i + 1))
    const ledger: LedgerEntry[] = []
    const tracker = new AgentHoursTracker(makeDb([sub], rollups, ledger), stubLogger, null)

    await tracker.runOnce()

    expect(ledger[0].rollupCount).toBe(600)
    expect(ledger[0].rollupIds.length).toBe(500) // capped
    expect(ledger[0].hoursAdded).toBe(600) // full sum, not capped
  })

  it('recovers from a crash between the ledger insert and the $inc (no under-count)', async () => {
    // Tick 1 writes the ledger entry, then the $inc is dropped (crash). The
    // cursor did NOT advance, so the range is still pending.
    const sub: Sub = { _id: 's1', userId: 'A', status: 'active', agentHoursUsed: 0 }
    const rollups = [roll('A', 1), roll('A', 2)]
    const ledger: LedgerEntry[] = []
    const failIncOnce = new Set(['s1'])
    const tracker = new AgentHoursTracker(
      makeDb([sub], rollups, ledger, { failIncOnce }),
      stubLogger,
      null,
    )

    await tracker.runOnce() // ledger written, $inc suppressed
    expect(ledger.length).toBe(1)
    expect(sub.agentHoursUsed).toBe(0) // $inc never landed
    expect(sub.lastBilledHourBucket).toBeUndefined()

    // Tick 2: ledger insert is a DUPLICATE (same sub+bucket). We must NOT skip
    // the $inc — the guard lets the still-pending range through.
    await tracker.runOnce()

    // BITE: `continue`-ing on the duplicate would leave agentHoursUsed at 0.
    expect(ledger.length).toBe(1) // no duplicate appended
    expect(sub.agentHoursUsed).toBe(2) // recovered
    expect(sub.lastBilledHourBucket).toEqual(hb(2))
  })
})
