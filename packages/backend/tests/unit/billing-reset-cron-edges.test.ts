/**
 * Reset-cron edge cases + claim/tracker atomicity (FASE 3b).
 *
 * Beyond the happy-path idempotency already covered (billing-reset-cron.test.ts):
 *   - a NOT-yet-expired subscription is never touched (the find lower bound),
 *   - a batch of expired subs each reset exactly once, independently,
 *   - a failure on ONE sub does not abort the run (per-sub error isolation),
 *   - a crash AFTER the claim but BEFORE the period rewrite LEAVES resetting:true
 *     — so the agent-hours tracker keeps skipping the sub (mutual exclusion holds
 *     through the crash) until the stale window lets a later run re-claim it.
 *
 * MUST BITE:
 *   - widening the find filter to all active subs bills/renews a live period,
 *   - a `break`/throw out of the per-sub loop on error drops the survivors,
 *   - releasing the claim (resetting:false) on the error path would re-expose a
 *     half-reset sub to the tracker → the atomicity assertion goes red.
 */

import { describe, expect, it } from "bun:test"
import { BillingResetCron } from "../../src/services/billing-reset-cron"
import { boostsCollectionFake } from "./_billing-fakes"

const stubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => stubLogger,
} as any

interface Sub {
  _id: string
  userId: string
  planId: string
  status: string
  customPrice: number | null
  paymentMethod: string
  agentHoursUsed: number
  currentPeriodStart: Date
  currentPeriodEnd: Date
  lastBilledHourBucket?: Date
  resetting?: boolean
  resettingAt?: Date
  cancelAtPeriodEnd?: boolean
  scheduledPlanChange?: { planId: string; scheduledAt: Date } | null
  terosProviderConfigId?: string | null
  teamId?: string | null
  endDate?: Date | null
}

function claimGuardOk(s: Sub, or: any[]): boolean {
  return or.some((cond) => {
    if (cond.resetting && "$ne" in cond.resetting) return s.resetting !== cond.resetting.$ne
    if (cond.resettingAt && "$lt" in cond.resettingAt)
      return s.resettingAt != null && s.resettingAt < cond.resettingAt.$lt
    return false
  })
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

/** `throwPlanFor` makes the plan lookup throw for a given planId (post-claim failure). */
function makeDb(subs: Sub[], invoices: any[], opts: { throwPlanFor?: string } = {}) {
  return {
    collection(name: string) {
      if (name === "billing_hour_boosts") {
        return boostsCollectionFake([])
      }
      if (name === "billing_subscriptions") {
        return {
          find(filter: any) {
            const lt: Date = filter.currentPeriodEnd.$lt
            return makeCursor(subs.filter((s) => s.status === "active" && s.currentPeriodEnd < lt))
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
            const s = subs.find((x) => x._id === filter._id)
            if (!s) return { matchedCount: 0 }
            Object.assign(s, update.$set)
            return { matchedCount: 1 }
          },
          async insertOne(doc: any) {
            subs.push(doc)
            return { insertedId: doc._id }
          },
        }
      }
      if (name === "billing_plans") {
        return {
          async findOne(f: any) {
            if (opts.throwPlanFor && f._id === opts.throwPlanFor)
              throw new Error("plan lookup boom")
            return { _id: f._id, price: 89, currency: "EUR", agentHoursLimit: 80 }
          },
        }
      }
      if (name === "billing_invoices") {
        return {
          async updateOne(filter: any, update: any, optsU: any) {
            const exists = invoices.find(
              (i) =>
                i.subscriptionId === filter.subscriptionId &&
                sameTime(i.periodStart, filter.periodStart) &&
                sameTime(i.periodEnd, filter.periodEnd),
            )
            if (exists) return { matchedCount: 1, upsertedCount: 0 }
            if (optsU?.upsert) {
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
          async findOne() {
            return null
          },
        }
      }
      if (name === "billing_period_snapshots") {
        return {
          async insertOne(doc: any) {
            return { insertedId: doc._id }
          },
        }
      }
      return null as any
    },
  } as any
}

function expiredSub(over: Partial<Sub> = {}): Sub {
  return {
    _id: "sub_1",
    userId: "u",
    planId: "plan_pro",
    status: "active",
    customPrice: null,
    paymentMethod: "manual",
    agentHoursUsed: 42,
    currentPeriodStart: new Date("2026-04-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-05-01T00:00:00Z"),
    lastBilledHourBucket: new Date("2026-04-20T00:00:00Z"),
    ...over,
  }
}

describe("BillingResetCron — edge cases", () => {
  it("does NOT touch a subscription whose period has not ended", async () => {
    const future = expiredSub({
      currentPeriodStart: new Date("2099-01-01T00:00:00Z"),
      currentPeriodEnd: new Date("2099-02-01T00:00:00Z"), // far in the future
    })
    const invoices: any[] = []
    const cron = new BillingResetCron(makeDb([future], invoices), stubLogger, null)

    const result = await cron.runOnce()

    // BITE: widening the find filter to all active subs renews a live period.
    expect(result.subscriptionsReset).toBe(0)
    expect(invoices).toHaveLength(0)
    expect(future.agentHoursUsed).toBe(42) // untouched
    expect(future.currentPeriodEnd).toEqual(new Date("2099-02-01T00:00:00Z"))
  })

  it("resets a batch of expired subs, each exactly once and independently", async () => {
    const subs = [
      expiredSub({ _id: "a", userId: "ua", agentHoursUsed: 10 }),
      expiredSub({ _id: "b", userId: "ub", agentHoursUsed: 20 }),
      expiredSub({ _id: "c", userId: "uc", agentHoursUsed: 30 }),
    ]
    const invoices: any[] = []
    const cron = new BillingResetCron(makeDb(subs, invoices), stubLogger, null)

    const result = await cron.runOnce()

    expect(result.subscriptionsReset).toBe(3)
    expect(invoices).toHaveLength(3)
    // Each zeroed, advanced, and released — no cross-contamination.
    for (const s of subs) {
      expect(s.agentHoursUsed).toBe(0)
      expect(s.resetting).toBe(false)
      expect(s.currentPeriodEnd.getTime()).toBeGreaterThan(
        new Date("2026-05-01T00:00:00Z").getTime(),
      )
    }
    // One invoice per distinct subscription.
    expect(new Set(invoices.map((i) => i.subscriptionId)).size).toBe(3)
  })

  it("a failure on one sub does not abort the run (per-sub error isolation)", async () => {
    const subs = [
      expiredSub({ _id: "bad", userId: "ubad", planId: "plan_broken" }),
      expiredSub({ _id: "good", userId: "ugood", planId: "plan_pro", agentHoursUsed: 5 }),
    ]
    const invoices: any[] = []
    const cron = new BillingResetCron(
      makeDb(subs, invoices, { throwPlanFor: "plan_broken" }),
      stubLogger,
      null,
    )

    const result = await cron.runOnce()

    // 'good' still reset despite 'bad' throwing mid-reset.
    expect(result.subscriptionsReset).toBe(1)
    const good = subs.find((s) => s._id === "good")!
    expect(good.agentHoursUsed).toBe(0)
    expect(good.resetting).toBe(false)
    expect(invoices.some((i) => i.subscriptionId === "good")).toBe(true)
    expect(cron.getMetrics().reset_errors).toBe(1)
  })

  it("leaves resetting:true after a crash post-claim (tracker keeps skipping)", async () => {
    // The failing sub was CLAIMED (resetting:true via findOneAndUpdate) before the
    // plan lookup threw. The renewal never ran, so the claim must persist — the
    // tracker (which filters resetting:{$ne:true}) keeps skipping it, preventing a
    // $inc onto a half-reset period. A later run re-claims it once stale.
    const bad = expiredSub({ _id: "bad", userId: "ubad", planId: "plan_broken" })
    const cron = new BillingResetCron(
      makeDb([bad], [], { throwPlanFor: "plan_broken" }),
      stubLogger,
      null,
    )

    await cron.runOnce()

    // BITE: releasing the claim (resetting:false) on the error path re-exposes a
    // half-reset sub to the tracker.
    expect(bad.resetting).toBe(true)
    expect(bad.resettingAt).toBeInstanceOf(Date)
    expect(bad.agentHoursUsed).toBe(42) // period NOT rewritten
  })

  it("matures a deferred downgrade: opens the scheduled plan, not a renewal (decision D)", async () => {
    const sub = expiredSub({
      planId: "plan_pro",
      scheduledPlanChange: { planId: "plan_basic", scheduledAt: new Date("2026-04-15T00:00:00Z") },
    })
    const subs = [sub]
    const invoices: any[] = []
    const cron = new BillingResetCron(makeDb(subs, invoices), stubLogger, null)

    const result = await cron.runOnce()

    expect(result.subscriptionsReset).toBe(1)
    // The ended (expensive) period is still invoiced — paid until the cut.
    expect(invoices).toHaveLength(1)
    // The old sub is CLOSED, its pending change cleared.
    const ended = subs.find((s) => s._id === "sub_1")!
    expect(ended.status).toBe("ended")
    expect(ended.endDate).toBeInstanceOf(Date)
    expect(ended.scheduledPlanChange).toBeNull()
    // A NEW active sub opens on the SCHEDULED cheaper plan, fresh.
    const opened = subs.find((s) => s._id !== "sub_1")!
    expect(opened).toBeDefined()
    // MUST BITE: a plain renewal (ignoring scheduledPlanChange) keeps planId=plan_pro
    // on the same sub and never opens a second one.
    expect(opened.planId).toBe("plan_basic")
    expect(opened.status).toBe("active")
    expect(opened.agentHoursUsed).toBe(0)
  })

  it("keeps the DRIFTED anchor across cycles (drift is desired — nota 3 blindaje)", async () => {
    // A month-end anchor (Jan 31) clamps to Feb 28 on the first renewal; the
    // SECOND renewal must start from Feb 28 and land on Mar 28 — NOT snap back to
    // the 31st. A Stripe-style "preserve original anchor" change would make cycle
    // 2 end on Mar 31 → red. This blinds the deliberate drift against a "fix".
    const sub = expiredSub({
      currentPeriodStart: new Date("2025-12-31T00:00:00Z"),
      currentPeriodEnd: new Date("2026-01-31T00:00:00Z"),
      lastBilledHourBucket: new Date("2026-01-20T00:00:00Z"),
    })
    const cron = new BillingResetCron(makeDb([sub], []), stubLogger, null)

    await cron.runOnce() // cycle 1: Jan 31 → Feb 28
    expect(sub.currentPeriodEnd.getUTCMonth()).toBe(1) // February
    expect(sub.currentPeriodEnd.getUTCDate()).toBe(28)

    await cron.runOnce() // cycle 2: Feb 28 → Mar 28 (drift persists, NOT Mar 31)
    expect(sub.currentPeriodEnd.getUTCMonth()).toBe(2) // March
    expect(sub.currentPeriodEnd.getUTCDate()).toBe(28)
  })
})
