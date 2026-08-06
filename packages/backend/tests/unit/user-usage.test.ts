/**
 * Per-user quota classification (TER-682) — pure logic + batched index.
 *
 * Run: bun test packages/backend/tests/unit/user-usage.test.ts
 *
 * BITES: the buckets MUST match the billing gate exactly (no meaning drift). Each
 * boundary case flips at the threshold the gate uses — mutate the source (e.g.
 * `>= USAGE_WARNING_THRESHOLD` → `>`, or drop the boost from the effective limit)
 * and a case turns red. `pct` is asserted numerically, not "is defined".
 */

import { describe, expect, it } from "bun:test"
import {
  buildUsageIndex,
  computeUserUsage,
  matchesUsageBucket,
  type UsageComputeInput,
  type UserUsage,
} from "../../src/handlers/domains/admin/_user-usage"
import { InMemoryDb } from "./_stripe-test-helpers"

const metered = (over: Partial<UsageComputeInput> = {}): UsageComputeInput => ({
  hasActiveSub: true,
  terosModel: true,
  baseLimit: 50,
  boostHours: 0,
  agentHoursUsed: 0,
  ...over,
})

describe("computeUserUsage", () => {
  it("metered: pct = used / effectiveLimit, no boost", () => {
    expect(computeUserUsage(metered({ agentHoursUsed: 40 }))).toEqual({
      hasSub: true,
      unmetered: false,
      effectiveLimit: 50,
      used: 40,
      boostHours: 0,
      pct: 0.8,
    })
  })

  it("metered: boost raises the effective limit and lowers pct", () => {
    // 60/50 would be exhausted; the 20h boost makes it 60/70 → not exhausted.
    expect(computeUserUsage(metered({ agentHoursUsed: 60, boostHours: 20 }))).toEqual({
      hasSub: true,
      unmetered: false,
      effectiveLimit: 70,
      used: 60,
      boostHours: 20,
      pct: 60 / 70,
    })
  })

  it("unmetered when Teros base limit <= 0 (mirrors the gate no-op)", () => {
    expect(computeUserUsage(metered({ baseLimit: 0, agentHoursUsed: 5 }))).toEqual({
      hasSub: true,
      unmetered: true,
      effectiveLimit: 0,
      used: 5,
      boostHours: 0,
      pct: null,
    })
  })

  it("unmetered when the plan lacks the Teros model, boost is dropped", () => {
    // Non-Teros plan: not enforced even with a positive base limit; boost ignored.
    expect(
      computeUserUsage(
        metered({ terosModel: false, baseLimit: 100, boostHours: 30, agentHoursUsed: 50 }),
      ),
    ).toEqual({
      hasSub: true,
      unmetered: true,
      effectiveLimit: 100,
      used: 50,
      boostHours: 0,
      pct: null,
    })
  })

  it("no active subscription → inert usage", () => {
    expect(computeUserUsage(metered({ hasActiveSub: false, agentHoursUsed: 99 }))).toEqual({
      hasSub: false,
      unmetered: false,
      effectiveLimit: 0,
      used: 0,
      boostHours: 0,
      pct: null,
    })
  })
})

describe("matchesUsageBucket — boundaries", () => {
  const u = (over: Partial<UsageComputeInput> = {}) => computeUserUsage(metered(over))

  it("near is [0.8, 1.0): 79% no, 80% yes, 99% yes, 100% no", () => {
    expect(matchesUsageBucket(u({ baseLimit: 100, agentHoursUsed: 79 }), "near")).toBe(false)
    expect(matchesUsageBucket(u({ baseLimit: 100, agentHoursUsed: 80 }), "near")).toBe(true)
    expect(matchesUsageBucket(u({ baseLimit: 100, agentHoursUsed: 99 }), "near")).toBe(true)
    expect(matchesUsageBucket(u({ baseLimit: 100, agentHoursUsed: 100 }), "near")).toBe(false)
  })

  it("exhausted is >= 1.0: 99% no, 100% yes, 120% yes", () => {
    expect(matchesUsageBucket(u({ baseLimit: 100, agentHoursUsed: 99 }), "exhausted")).toBe(false)
    expect(matchesUsageBucket(u({ baseLimit: 100, agentHoursUsed: 100 }), "exhausted")).toBe(true)
    expect(matchesUsageBucket(u({ baseLimit: 100, agentHoursUsed: 120 }), "exhausted")).toBe(true)
  })

  it("has_boost only when an active boost contributes", () => {
    expect(matchesUsageBucket(u({ boostHours: 20 }), "has_boost")).toBe(true)
    expect(matchesUsageBucket(u({ boostHours: 0 }), "has_boost")).toBe(false)
    // Unmetered drops the boost → not has_boost even if input boost > 0.
    expect(matchesUsageBucket(u({ terosModel: false, boostHours: 20 }), "has_boost")).toBe(false)
  })

  it("unmetered / near / exhausted are mutually consistent for an unmetered sub", () => {
    const um = u({ baseLimit: 0, agentHoursUsed: 999 })
    expect(matchesUsageBucket(um, "unmetered")).toBe(true)
    expect(matchesUsageBucket(um, "near")).toBe(false)
    expect(matchesUsageBucket(um, "exhausted")).toBe(false)
  })

  it("no_sub only for a user without an active subscription", () => {
    const noSub: UserUsage = computeUserUsage(metered({ hasActiveSub: false }))
    expect(matchesUsageBucket(noSub, "no_sub")).toBe(true)
    expect(matchesUsageBucket(u(), "no_sub")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildUsageIndex — batched classification over active subscriptions
// ---------------------------------------------------------------------------

const WINDOW = { periodStart: new Date("2020-01-01"), periodEnd: new Date("2999-01-01") }

function plan(_id: string, agentHoursLimit: number, terosModel = true) {
  return { _id, name: _id, displayName: _id, agentHoursLimit, features: { terosModel } }
}
function sub(
  userId: string,
  planId: string,
  agentHoursUsed: number,
  customAgentHoursLimit: number | null = null,
) {
  return {
    _id: `sub_${userId}`,
    userId,
    planId,
    status: "active",
    agentHoursUsed,
    customAgentHoursLimit,
  }
}
function boost(userId: string, hours: number) {
  return {
    _id: `boost_${userId}`,
    userId,
    subscriptionId: `sub_${userId}`,
    hours,
    status: "active",
    ...WINDOW,
  }
}

function seedDb() {
  const db = new InMemoryDb()
  db.seed("billing_plans", [
    plan("plan_growth", 50),
    plan("plan_unlimited", -1),
    plan("plan_byok", 0, false),
  ])
  db.seed("billing_subscriptions", [
    sub("u_near", "plan_growth", 45), // 45/50 = 0.9 near
    sub("u_exhausted", "plan_growth", 50), // 50/50 = 1.0 exhausted
    sub("u_low", "plan_growth", 5), // 0.1 none
    sub("u_boost", "plan_growth", 60), // 60/50 exhausted UNTIL boost → 60/70 = 0.857 near
    sub("u_unmetered", "plan_unlimited", 500),
  ])
  db.seed("billing_hour_boosts", [boost("u_boost", 20)])
  return db
}

describe("buildUsageIndex", () => {
  it("classifies each active sub into the right bucket, boost applied", async () => {
    const index = await buildUsageIndex(seedDb() as any, new Date("2026-07-01"))

    expect(index.activeSubUserIds.sort()).toEqual(
      ["u_near", "u_exhausted", "u_low", "u_boost", "u_unmetered"].sort(),
    )
    // u_boost's 20h boost pulls 60h under the limit (60/70 = 0.857) → NOT
    // exhausted but still >=80% → near. Buckets are not mutually exclusive.
    expect(index.bucketUserIds.near.sort()).toEqual(["u_boost", "u_near"].sort())
    expect(index.bucketUserIds.exhausted.sort()).toEqual(["u_exhausted"])
    expect(index.bucketUserIds.has_boost.sort()).toEqual(["u_boost"])
    expect(index.bucketUserIds.unmetered.sort()).toEqual(["u_unmetered"])
    expect(index.bucketUserIds.exhausted).not.toContain("u_boost")
  })

  it("exposes effective limit + pct per user (boost-aware)", async () => {
    const index = await buildUsageIndex(seedDb() as any, new Date("2026-07-01"))
    expect(index.usageByUser.get("u_boost")).toEqual({
      hasSub: true,
      unmetered: false,
      effectiveLimit: 70,
      used: 60,
      boostHours: 20,
      pct: 60 / 70,
    })
    expect(index.usageByUser.get("u_unmetered")?.unmetered).toBe(true)
  })

  it("groups userIds by plan", async () => {
    const index = await buildUsageIndex(seedDb() as any, new Date("2026-07-01"))
    expect((index.planUserIds.get("plan_growth") ?? []).sort()).toEqual(
      ["u_near", "u_exhausted", "u_low", "u_boost"].sort(),
    )
    expect(index.planUserIds.get("plan_unlimited")).toEqual(["u_unmetered"])
  })

  it("ignores boosts whose window does not contain `now`", async () => {
    const db = new InMemoryDb()
    db.seed("billing_plans", [plan("plan_growth", 50)])
    db.seed("billing_subscriptions", [sub("u_boost", "plan_growth", 60)])
    db.seed("billing_hour_boosts", [
      {
        _id: "b1",
        userId: "u_boost",
        subscriptionId: "sub_u_boost",
        hours: 20,
        status: "active",
        periodStart: new Date("2020-01-01"),
        periodEnd: new Date("2020-02-01"),
      },
    ])
    const index = await buildUsageIndex(db as any, new Date("2026-07-01"))
    // Expired-window boost does not count → 60/50 stays exhausted, no boost.
    expect(index.usageByUser.get("u_boost")?.boostHours).toBe(0)
    expect(index.bucketUserIds.exhausted).toEqual(["u_boost"])
    expect(index.bucketUserIds.has_boost).toEqual([])
  })
})
