/**
 * Concurrency + audit-invariant tests for AgentHoursTracker (FASE 3a).
 *
 * Two things the single-instance tracker tests cannot show:
 *
 *  1. MULTI-INSTANCE RACE (reproduces the historical double-count and kills it).
 *     Leader election keeps one writer in production, but the atomic compare-
 *     and-swap on `updateOne` ({ lastBilledHourBucket: { $lt: max } }) is the
 *     real authority of idempotency — the "second line of defense" in the code.
 *     Here we run TWO trackers concurrently against the SAME subscription, gated
 *     by a barrier so both read the same cutoff and compute the same range
 *     BEFORE either writes (the exact shape of a double-count). The CAS lets
 *     only one commit; the unique ledger index rejects the second's entry.
 *     Net: agentHoursUsed billed ONCE, one ledger row — no double-count.
 *
 *  2. INVARIANT "every committed $inc has a ledger entry". The tracker writes the
 *     ledger BEFORE the $inc (FASE 2a) precisely so a crash can never leave money
 *     billed without an audit row. We assert call ORDER (ledger insert precedes
 *     the matching $inc) and the 1:1 accounting (sum of ledger.hoursAdded ==
 *     agentHoursUsed) across a multi-commit sequence.
 *
 * MUST BITE:
 *   - removing the `$or: lastBilledHourBucket < max` CAS guard → both racers
 *     commit → agentHoursUsed = 2N → the "billed once" assertion goes red,
 *   - moving the $inc before the ledger insert → the call-order assertion red,
 *   - swallowing per-sub errors silently (no tracker_errors++) → isolation red.
 */

import { describe, expect, it } from "bun:test"
import { MongoServerError } from "mongodb"
import { AgentHoursTracker } from "../../src/services/agent-hours-tracker"

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
  resetting?: boolean
}
interface Rollup {
  _id: string
  groupKey: { userId: string }
  hourBucket: Date
  userActiveMs: number
}
interface Ledger {
  _id: string
  subscriptionId: string
  userId: string
  hourBucket: Date
  hoursAdded: number
  cumulative: number
  trackerRunId: string
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
          return Promise.resolve(
            i < items.length
              ? { value: items[i++], done: false }
              : { value: undefined, done: true },
          )
        },
      }
    },
    async close() {},
  }
}

function dupKeyError(): MongoServerError {
  const err = new MongoServerError({ message: "E11000 duplicate key" })
  ;(err as any).code = 11000
  return err
}

/** Releases all waiters once `n` have arrived — forces a real interleaving. */
function makeBarrier(n: number) {
  let count = 0
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  return async () => {
    count++
    if (count >= n) release()
    await gate
  }
}

/**
 * Shared in-memory db. `updateOne` implements the faithful atomic CAS (re-reads
 * the LIVE cursor, applies only if still behind the committed max). `ledger`
 * enforces the unique (subscriptionId, hourBucket) index. `aggBarrier`, when
 * set, makes every aggregate read wait until N readers have arrived, so racers
 * observe the same pre-write cutoff. `callOrder` records ledger/inc ordering.
 */
function makeDb(
  subs: Sub[],
  rollups: Rollup[],
  ledger: Ledger[],
  opts: { aggBarrier?: () => Promise<void>; throwAggFor?: Set<string>; callOrder?: string[] } = {},
) {
  return {
    collection(name: string) {
      if (name === "billing_subscriptions") {
        return {
          find(filter: any) {
            return makeCursor(
              subs.filter((s) => {
                if (s.status !== filter.status) return false
                if (filter.resetting && "$ne" in filter.resetting)
                  return s.resetting !== filter.resetting.$ne
                return true
              }),
            )
          },
          async updateOne(filter: any, update: any) {
            const sub = subs.find((s) => s.userId === filter.userId && s.status === "active")
            if (!sub) return { matchedCount: 0 }
            if (filter.resetting && "$ne" in filter.resetting && sub.resetting === true)
              return { matchedCount: 0 }
            const maxHour: Date = filter.$or[0].lastBilledHourBucket.$lt
            // Atomic compare-and-swap: only advance if still strictly behind.
            const guardOk = sub.lastBilledHourBucket == null || sub.lastBilledHourBucket < maxHour
            if (!guardOk) return { matchedCount: 0 }
            sub.agentHoursUsed = (sub.agentHoursUsed ?? 0) + update.$inc.agentHoursUsed
            sub.lastBilledHourBucket = update.$set.lastBilledHourBucket
            opts.callOrder?.push(`inc:${sub._id}:${+maxHour}`)
            return { matchedCount: 1 }
          },
        }
      }
      if (name === "agent_usage_rollups_user_hourly") {
        return {
          aggregate(pipeline: any[]) {
            const match = pipeline[0].$match
            const uid: string = match["groupKey.userId"]
            const gt: Date = match.hourBucket.$gt
            return {
              async toArray() {
                if (opts.throwAggFor?.has(uid)) throw new Error(`boom for ${uid}`)
                if (opts.aggBarrier) await opts.aggBarrier()
                const rows = rollups.filter((r) => r.groupKey.userId === uid && r.hourBucket > gt)
                if (rows.length === 0) return []
                const totalMs = rows.reduce((a, r) => a + r.userActiveMs, 0)
                const maxHourBucket = rows.reduce(
                  (m, r) => (r.hourBucket > m ? r.hourBucket : m),
                  rows[0].hourBucket,
                )
                return [
                  { totalMs, maxHourBucket, count: rows.length, rollupIds: rows.map((r) => r._id) },
                ]
              },
            }
          },
        }
      }
      if (name === "billing_hour_ledger") {
        return {
          async insertOne(doc: Ledger) {
            const dup = ledger.find(
              (e) => e.subscriptionId === doc.subscriptionId && +e.hourBucket === +doc.hourBucket,
            )
            if (dup) throw dupKeyError()
            ledger.push(doc)
            opts.callOrder?.push(`ledger:${doc.subscriptionId}:${+doc.hourBucket}`)
            return { insertedId: doc._id }
          },
        }
      }
      return null as any
    },
  } as any
}

describe("AgentHoursTracker — multi-instance race (anti double-count)", () => {
  it("two concurrent trackers bill the same sub exactly once (CAS + unique ledger)", async () => {
    const sub: Sub = { _id: "s1", userId: "A", status: "active", agentHoursUsed: 0 }
    const rollups = [roll("A", 1), roll("A", 2), roll("A", 3)] // 3h pending
    const ledger: Ledger[] = []
    // Barrier of 2: both trackers must reach the aggregate read before either
    // proceeds to write — the precise window the old global-cutoff bug doubled.
    const aggBarrier = makeBarrier(2)
    const db = makeDb([sub], rollups, ledger, { aggBarrier })

    const t1 = new AgentHoursTracker(db, stubLogger, null)
    const t2 = new AgentHoursTracker(db, stubLogger, null)
    const [r1, r2] = await Promise.all([t1.runOnce(), t2.runOnce()])

    // Billed ONCE. BITE: dropping the CAS guard makes this 6 (3h twice).
    expect(sub.agentHoursUsed).toBe(3)
    expect(sub.lastBilledHourBucket).toEqual(hb(3))
    // Exactly one ledger row (the loser's insert hit the unique index).
    expect(ledger).toHaveLength(1)
    expect(ledger[0].hoursAdded).toBe(3)
    // Exactly one of the two runs reports the bill.
    expect(r1.usersBilled + r2.usersBilled).toBe(1)
    expect(r1.hoursAdded + r2.hoursAdded).toBe(3)
  })

  it("the ledger unique index alone blocks a duplicate audit row under the race", async () => {
    // Even if both racers somehow reached the ledger, only one row survives.
    const sub: Sub = { _id: "s1", userId: "A", status: "active", agentHoursUsed: 0 }
    const rollups = [roll("A", 1), roll("A", 2)]
    const ledger: Ledger[] = []
    const aggBarrier = makeBarrier(2)
    const db = makeDb([sub], rollups, ledger, { aggBarrier })
    const t1 = new AgentHoursTracker(db, stubLogger, null)
    const t2 = new AgentHoursTracker(db, stubLogger, null)

    await Promise.all([t1.runOnce(), t2.runOnce()])

    expect(ledger).toHaveLength(1)
    expect(ledger[0].subscriptionId).toBe("s1")
    expect(ledger[0].hourBucket).toEqual(hb(2))
  })
})

describe("AgentHoursTracker — invariant: every $inc has a ledger entry", () => {
  it("writes the ledger BEFORE the $inc for every commit (crash-safe ordering)", async () => {
    const sub: Sub = { _id: "s1", userId: "A", status: "active", agentHoursUsed: 0 }
    const rollups = [roll("A", 1), roll("A", 2)]
    const ledger: Ledger[] = []
    const callOrder: string[] = []
    const db = makeDb([sub], rollups, ledger, { callOrder })
    const tracker = new AgentHoursTracker(db, stubLogger, null)

    await tracker.runOnce()

    // BITE: moving the $inc before the ledger insert flips this order.
    expect(callOrder).toEqual(["ledger:s1:" + +hb(2), "inc:s1:" + +hb(2)])
  })

  it("keeps 1:1 accounting across a multi-commit sequence (sum ledger == counter)", async () => {
    const sub: Sub = { _id: "s1", userId: "A", status: "active", agentHoursUsed: 0 }
    const rollups = [roll("A", 1), roll("A", 2)]
    const ledger: Ledger[] = []
    const tracker = new AgentHoursTracker(makeDb([sub], rollups, ledger), stubLogger, null)

    await tracker.runOnce()
    rollups.push(roll("A", 3), roll("A", 4), roll("A", 5))
    await tracker.runOnce()
    rollups.push(roll("A", 6))
    await tracker.runOnce()

    // One ledger row per commit; their hoursAdded sum to the counter exactly.
    const sumLedger = ledger.reduce((a, e) => a + e.hoursAdded, 0)
    expect(ledger).toHaveLength(3)
    expect(sumLedger).toBe(sub.agentHoursUsed)
    expect(sub.agentHoursUsed).toBe(6)
    // cumulative is monotonic and ends at the counter.
    expect(ledger.map((e) => e.cumulative)).toEqual([2, 5, 6])
  })
})

describe("AgentHoursTracker — per-subscription error isolation", () => {
  it("a failure billing one sub does not stop the others; errors are counted", async () => {
    const bad: Sub = { _id: "bad", userId: "BAD", status: "active", agentHoursUsed: 0 }
    const good: Sub = { _id: "good", userId: "GOOD", status: "active", agentHoursUsed: 0 }
    const rollups = [roll("BAD", 1), roll("GOOD", 1), roll("GOOD", 2)]
    const ledger: Ledger[] = []
    const tracker = new AgentHoursTracker(
      makeDb([bad, good], rollups, ledger, { throwAggFor: new Set(["BAD"]) }),
      stubLogger,
      null,
    )

    const result = await tracker.runOnce()

    // GOOD still billed despite BAD throwing — no early abort of the run.
    expect(good.agentHoursUsed).toBe(2)
    expect(bad.agentHoursUsed).toBe(0)
    expect(result.usersBilled).toBe(1)
    // BITE: the per-sub try/catch must increment tracker_errors (observability).
    expect(tracker.getMetrics().tracker_errors).toBe(1)
  })
})
