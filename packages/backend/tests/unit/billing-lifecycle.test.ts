/**
 * End-to-end billing lifecycle (FASE 3e).
 *
 * Drives the THREE real services — AgentHoursTracker, BillingResetCron,
 * BillingReconciliationCron — against ONE shared in-memory Mongo fake, through a
 * full two-period cycle:
 *
 *   signup → usage (rollups) → tracker bills + ledgers → reconcile (drift 0)
 *          → period ends → reset invoices + snapshots + zeroes + advances
 *          → new-period usage → tracker bills → reconcile (drift 0)
 *
 * The crown assertion is the historical double-count, reproduced end to end: the
 * reset PRESERVES lastBilledHourBucket. Because the preserved cursor sits past
 * period 1's rollups, the new period bills ONLY its own hours (3h), not the
 * already-billed history re-summed (which would be 8h). The reconciliation cron,
 * re-deriving from the raw rollups, confirms drift 0 in both periods.
 *
 * MUST BITE: making the reset $unset lastBilledHourBucket (the FASE-0 bug)
 * re-sums period 1 into period 2 → agentHoursUsed 8 not 3, and reconciliation
 * flags a 3h drift. Both assertions go red.
 */

import { describe, expect, it } from "bun:test"
import { boostsCollectionFake } from "./_billing-fakes"
import { AgentHoursTracker } from "../../src/services/agent-hours-tracker"
import { BillingReconciliationCron } from "../../src/services/billing-reconciliation-cron"
import { BillingResetCron } from "../../src/services/billing-reset-cron"

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
/** Hour bucket as a Date relative to a fixed epoch. */
function hb(h: number): Date {
  return new Date(Date.UTC(2026, 0, 1, 0) + h * HOUR_MS)
}

interface Sub {
  _id: string
  userId: string
  planId: string
  status: string
  customPrice: number | null
  customAgentHoursLimit: number | null
  paymentMethod: string
  agentHoursUsed: number
  overageHours: number
  currentPeriodStart: Date
  currentPeriodEnd: Date
  lastBilledHourBucket?: Date
  resetting?: boolean
  resettingAt?: Date
  cancelAtPeriodEnd?: boolean
  startDate?: Date
  endDate?: Date | null
}
interface Rollup {
  _id: string
  groupKey: { userId: string }
  hourBucket: Date
  userActiveMs: number
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
const sameTime = (a: Date, b: Date) => a.getTime() === b.getTime()

function claimGuardOk(s: Sub, or: any[]): boolean {
  return or.some((cond) => {
    if (cond.resetting && "$ne" in cond.resetting) return s.resetting !== cond.resetting.$ne
    if (cond.resettingAt && "$lt" in cond.resettingAt)
      return s.resettingAt != null && s.resettingAt < cond.resettingAt.$lt
    return false
  })
}

/** Shared world: every collection the three services touch, faithfully. */
function makeWorld() {
  const subs: Sub[] = []
  const rollups: Rollup[] = []
  const ledger: any[] = []
  const invoices: any[] = []
  const snapshots: any[] = []
  const boosts: any[] = []
  const plans = [{ _id: "plan_pro", name: "pro", currency: "EUR", price: 89, agentHoursLimit: 80 }]

  const db = {
    collection(name: string) {
      switch (name) {
        case "billing_hour_boosts":
          return boostsCollectionFake(boosts)
        case "billing_subscriptions":
          return {
            find(filter: any) {
              let rows = subs.filter((s) => s.status === filter.status)
              if (filter.resetting && "$ne" in filter.resetting)
                rows = rows.filter((s) => s.resetting !== filter.resetting.$ne)
              if (filter.currentPeriodEnd?.$lt)
                rows = rows.filter((s) => s.currentPeriodEnd < filter.currentPeriodEnd.$lt)
              return makeCursor(rows)
            },
            async findOne(f: any) {
              if (f._id) return subs.find((s) => s._id === f._id) ?? null
              return (
                subs.find(
                  (s) => s.userId === f.userId && (f.status === undefined || s.status === f.status),
                ) ?? null
              )
            },
            async findOneAndUpdate(filter: any, update: any) {
              const s = subs.find(
                (x) =>
                  x._id === filter._id &&
                  x.status === "active" &&
                  x.currentPeriodEnd < filter.currentPeriodEnd.$lt,
              )
              if (!s) return null
              if (filter.$or && !claimGuardOk(s, filter.$or)) return null
              Object.assign(s, update.$set)
              return { ...s }
            },
            async updateOne(filter: any, update: any) {
              // Tracker CAS (by userId, with $or cursor guard) vs reset (by _id).
              let s: Sub | undefined
              if (filter.$or) {
                s = subs.find((x) => x.userId === filter.userId && x.status === "active")
                if (!s) return { matchedCount: 0 }
                if (filter.resetting && "$ne" in filter.resetting && s.resetting === true)
                  return { matchedCount: 0 }
                const maxHour: Date = filter.$or[0].lastBilledHourBucket.$lt
                if (!(s.lastBilledHourBucket == null || s.lastBilledHourBucket < maxHour))
                  return { matchedCount: 0 }
              } else {
                s = subs.find((x) => x._id === filter._id)
                if (!s) return { matchedCount: 0 }
              }
              if (update.$inc?.agentHoursUsed)
                s.agentHoursUsed = (s.agentHoursUsed ?? 0) + update.$inc.agentHoursUsed
              if (update.$set) Object.assign(s, update.$set)
              if (update.$unset) for (const k of Object.keys(update.$unset)) delete (s as any)[k]
              return { matchedCount: 1 }
            },
            async insertOne(doc: any) {
              subs.push(doc)
              return { insertedId: doc._id }
            },
          }
        case "agent_usage_rollups_user_hourly":
          return {
            aggregate(pipeline: any[]) {
              const match = pipeline[0].$match
              const group = pipeline[1].$group
              const uid: string = match["groupKey.userId"]
              const gt: Date = match.hourBucket.$gt
              const lte: Date | undefined = match.hourBucket.$lte
              const rows = rollups.filter(
                (r) =>
                  r.groupKey.userId === uid &&
                  r.hourBucket > gt &&
                  (lte === undefined || r.hourBucket <= lte),
              )
              return {
                async toArray() {
                  if ("maxHourBucket" in group) {
                    if (rows.length === 0) return []
                    return [
                      {
                        totalMs: rows.reduce((a, r) => a + r.userActiveMs, 0),
                        maxHourBucket: rows.reduce(
                          (m, r) => (r.hourBucket > m ? r.hourBucket : m),
                          rows[0].hourBucket,
                        ),
                        count: rows.length,
                        rollupIds: rows.map((r) => r._id),
                      },
                    ]
                  }
                  if ("oldest" in group) {
                    if (rows.length === 0) return []
                    return [
                      {
                        oldest: rows.reduce(
                          (m, r) => (r.hourBucket < m ? r.hourBucket : m),
                          rows[0].hourBucket,
                        ),
                      },
                    ]
                  }
                  return [{ totalMs: rows.reduce((a, r) => a + r.userActiveMs, 0) }]
                },
              }
            },
          }
        case "billing_plans":
          return {
            async findOne(f: any) {
              return plans.find((p) => p._id === f._id) ?? null
            },
          }
        case "billing_hour_ledger":
          return {
            async insertOne(doc: any) {
              if (
                ledger.find(
                  (e) =>
                    e.subscriptionId === doc.subscriptionId && +e.hourBucket === +doc.hourBucket,
                )
              ) {
                const err: any = new Error("E11000")
                err.code = 11000
                throw err
              }
              ledger.push(doc)
              return { insertedId: doc._id }
            },
          }
        case "billing_invoices":
          return {
            async updateOne(filter: any, update: any, opts: any) {
              const exists = invoices.find(
                (i) =>
                  i.subscriptionId === filter.subscriptionId &&
                  sameTime(i.periodStart, filter.periodStart) &&
                  sameTime(i.periodEnd, filter.periodEnd),
              )
              if (exists) return { matchedCount: 1, upsertedCount: 0 }
              if (opts?.upsert) {
                const doc = {
                  subscriptionId: filter.subscriptionId,
                  periodStart: filter.periodStart,
                  periodEnd: filter.periodEnd,
                  ...update.$setOnInsert,
                }
                invoices.push(doc)
                return { matchedCount: 0, upsertedCount: 1, upsertedId: doc._id }
              }
              return { matchedCount: 0, upsertedCount: 0 }
            },
            async findOne(filter: any) {
              return (
                invoices.find(
                  (i) =>
                    i.subscriptionId === filter.subscriptionId &&
                    sameTime(i.periodStart, filter.periodStart) &&
                    sameTime(i.periodEnd, filter.periodEnd),
                ) ?? null
              )
            },
            aggregate() {
              // Duplicate-invoice detector: group by (sub, period), keep count>1.
              return {
                async toArray() {
                  const groups = new Map<string, number>()
                  for (const i of invoices) {
                    const k = `${i.subscriptionId}|${+i.periodStart}|${+i.periodEnd}`
                    groups.set(k, (groups.get(k) ?? 0) + 1)
                  }
                  const dups = [...groups.values()].filter((c) => c > 1).length
                  return dups > 0 ? [{ groups: dups }] : []
                },
              }
            },
          }
        case "billing_period_snapshots":
          return {
            async insertOne(doc: any) {
              if (
                snapshots.find(
                  (s) =>
                    s.subscriptionId === doc.subscriptionId &&
                    sameTime(s.periodStart, doc.periodStart) &&
                    sameTime(s.periodEnd, doc.periodEnd),
                )
              ) {
                const err: any = new Error("E11000")
                err.code = 11000
                throw err
              }
              snapshots.push(doc)
              return { insertedId: doc._id }
            },
          }
        default:
          return null as any
      }
    },
  } as any

  return { db, subs, rollups, ledger, invoices, snapshots }
}

describe("billing lifecycle — full two-period cycle (FASE 3e)", () => {
  it("signup → bill → reconcile → reset → bill → reconcile, with zero drift and no double-count", async () => {
    const w = makeWorld()
    const tracker = new AgentHoursTracker(w.db, stubLogger, null)
    const reset = new BillingResetCron(w.db, stubLogger, null)
    const recon = new BillingReconciliationCron(w.db, stubLogger, null)

    // ── 1. Signup: a fresh Pro subscription, never billed. Period 1 = [0h, 720h]
    w.subs.push({
      _id: "sub_1",
      userId: "A",
      planId: "plan_pro",
      status: "active",
      customPrice: null,
      customAgentHoursLimit: null,
      paymentMethod: "manual",
      agentHoursUsed: 0,
      overageHours: 0,
      currentPeriodStart: hb(0),
      currentPeriodEnd: hb(720),
      startDate: hb(0),
      endDate: null,
    })

    // ── 2. Usage in period 1: 5 active hours at buckets 1..5.
    for (let h = 1; h <= 5; h++) w.rollups.push(roll("A", h))

    // ── 3. Tracker bills period 1.
    await tracker.runOnce()
    const sub = () => w.subs.find((s) => s._id === "sub_1")!
    expect(sub().agentHoursUsed).toBe(5)
    expect(sub().lastBilledHourBucket).toEqual(hb(5))
    expect(w.ledger).toHaveLength(1)
    expect(w.ledger[0].hoursAdded).toBe(5)

    // ── 4. Reconcile period 1: rollups (0, 5] = 5h, counter 5h → drift 0.
    const r1 = await recon.runOnce({ now: hb(6) })
    expect(r1.subsChecked).toBe(1)
    expect(r1.driftIncidents).toBe(0)
    expect(r1.maxDriftHours).toBe(0)

    // ── 5. Period 1 ends: reset invoices, snapshots, zeroes, advances, PRESERVES
    //       the cursor. Run "after" period end (currentPeriodEnd hb(720) < now).
    await reset.runOnce()
    expect(w.invoices).toHaveLength(1)
    expect(w.invoices[0].amount).toBe(89)
    expect(w.snapshots).toHaveLength(1)
    expect(w.snapshots[0].agentHoursUsed).toBe(5) // captured before zeroing
    expect(sub().agentHoursUsed).toBe(0) // counter zeroed
    expect(sub().lastBilledHourBucket).toEqual(hb(5)) // cursor PRESERVED (key!)
    expect(sub().currentPeriodStart).toEqual(hb(720)) // advanced
    expect(sub().resetting).toBe(false) // claim released

    // ── 6. New usage in period 2 (buckets 721..723 = 3h).
    for (let h = 721; h <= 723; h++) w.rollups.push(roll("A", h))

    // ── 7. Tracker bills period 2. The preserved cursor (hb 5) excludes period 1's
    //       rollups, so ONLY the 3 new hours are billed.
    await tracker.runOnce()
    // CROWN BITE: $unset-ing the cursor on reset would re-sum buckets 1..5 here
    // → agentHoursUsed = 8. The preserved cursor keeps it at 3.
    expect(sub().agentHoursUsed).toBe(3)
    expect(sub().lastBilledHourBucket).toEqual(hb(723))
    expect(w.ledger).toHaveLength(2)

    // ── 8. Reconcile period 2: rollups (720, 723] = 3h, counter 3h → drift 0.
    const r2 = await recon.runOnce({ now: hb(724) })
    expect(r2.subsChecked).toBe(1)
    expect(r2.driftIncidents).toBe(0)
    expect(r2.maxDriftHours).toBe(0)
    expect(r2.invoiceDuplicates).toBe(0)

    // Whole cycle: exactly one invoice + one snapshot for the single closed period.
    expect(w.invoices).toHaveLength(1)
    expect(w.snapshots).toHaveLength(1)
  })

  it("a second reset with no elapsed period is a no-op (idempotent cycle)", async () => {
    // The reset cron uses the real `new Date()` for "now", so anchor the period
    // just-ended relative to real time: end = now - 1 day (expired), so after the
    // reset the advanced period (≈1 month out) is in the future → second run no-op.
    const realNow = new Date()
    const justEnded = new Date(realNow.getTime() - 24 * HOUR_MS)
    const periodStart = new Date(realNow.getTime() - 31 * 24 * HOUR_MS)
    const w = makeWorld()
    const reset = new BillingResetCron(w.db, stubLogger, null)
    w.subs.push({
      _id: "sub_1",
      userId: "A",
      planId: "plan_pro",
      status: "active",
      customPrice: null,
      customAgentHoursLimit: null,
      paymentMethod: "manual",
      agentHoursUsed: 5,
      overageHours: 0,
      currentPeriodStart: periodStart,
      currentPeriodEnd: justEnded,
      lastBilledHourBucket: periodStart,
      startDate: periodStart,
      endDate: null,
    })

    const r1 = await reset.runOnce() // period expired → reset, advances ~1 month ahead
    const afterFirst = w.invoices.length
    const r2 = await reset.runOnce() // new period not yet expired → no-op

    expect(r1.subscriptionsReset).toBe(1)
    expect(afterFirst).toBe(1)
    expect(r2.subscriptionsReset).toBe(0)
    expect(w.invoices).toHaveLength(1) // still one
  })
})
