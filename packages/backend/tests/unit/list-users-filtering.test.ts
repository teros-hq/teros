/**
 * admin.list-users — plan/usage filtering + KPI summary, end-to-end over the
 * in-memory db with the REAL UserService (TER-682).
 *
 * Run: bun test packages/backend/tests/unit/list-users-filtering.test.ts
 *
 * This exercises the real paginate+count path: buildUsageIndex classifies the
 * seeded subs, the handler turns a filter into a userId restriction, and
 * UserService.listUsers/countUsers/getUserSummary run against the faithful fake
 * (find/countDocuments/$in/$nin/skip). BITES: if the handler dropped the usage
 * filter, `total` would be the whole set, not the bucket; if `summary` were
 * computed over the applied filter, `summary.total` would collapse to the page.
 */

import { describe, expect, it } from "bun:test"
import type { WsHandlerContext } from "@teros/shared"
import { UserService } from "../../src/auth/user-service"
import { createListUsersHandler } from "../../src/handlers/domains/admin/list-users"
import { InMemoryDb } from "./_stripe-test-helpers"

const ctx = (userId: string): WsHandlerContext => ({ userId }) as any

const WINDOW = { periodStart: new Date("2020-01-01"), periodEnd: new Date("2999-01-01") }

function user(userId: string, role: "user" | "admin" | "super", i: number) {
  return {
    userId,
    role,
    status: "active",
    emailVerified: true,
    accessGranted: false,
    badges: [],
    profile: { displayName: `name-${userId}`, email: `${userId}@x.com`, avatarUrl: null },
    createdAt: new Date(2026, 0, i + 1),
    updatedAt: new Date(2026, 0, i + 1),
  }
}
function plan(_id: string, agentHoursLimit: number, terosModel = true) {
  return { _id, name: _id, displayName: _id, agentHoursLimit, features: { terosModel } }
}
function sub(userId: string, planId: string, agentHoursUsed: number) {
  return {
    _id: `sub_${userId}`,
    userId,
    planId,
    status: "active",
    agentHoursUsed,
    customAgentHoursLimit: null,
  }
}

function seed() {
  const db = new InMemoryDb()
  db.seed("users", [
    user("admin1", "admin", 0), // no sub → no_sub
    user("u_near", "user", 1),
    user("u_exhausted", "user", 2),
    user("u_low", "user", 3),
    user("u_boost", "user", 4),
    user("u_unmetered", "user", 5),
    user("u_nosub", "user", 6), // no sub → no_sub
  ])
  db.seed("billing_plans", [plan("plan_growth", 50), plan("plan_unlimited", -1)])
  db.seed("billing_subscriptions", [
    sub("u_near", "plan_growth", 45), // 0.90 near
    sub("u_exhausted", "plan_growth", 50), // 1.00 exhausted
    sub("u_low", "plan_growth", 5), // 0.10 none
    sub("u_boost", "plan_growth", 60), // 60/70 = 0.857 near (post-boost)
    sub("u_unmetered", "plan_unlimited", 500), // unmetered
  ])
  db.seed("billing_hour_boosts", [
    {
      _id: "boost_u_boost",
      userId: "u_boost",
      subscriptionId: "sub_u_boost",
      hours: 20,
      status: "active",
      ...WINDOW,
    },
  ])
  const svc = new UserService(db as any)
  return createListUsersHandler(svc, db as any)
}

const idsOf = (res: any) => (res.users as any[]).map((u) => u.userId).sort()

describe("admin.list-users — KPI summary", () => {
  it("reports nearLimit/exhausted over the whole user-level set", async () => {
    const res: any = await seed()(ctx("admin1"), {})
    expect(res.total).toBe(7)
    // near = {u_near 0.9, u_boost 0.857}; exhausted = {u_exhausted}.
    expect(res.summary).toEqual({ total: 7, active: 7, admins: 1, nearLimit: 2, exhausted: 1 })
  })

  it("enriches each row with period quota (boost-aware effective limit)", async () => {
    const res: any = await seed()(ctx("admin1"), {})
    const near = res.users.find((u: any) => u.userId === "u_near")
    expect(near.billing).toEqual({
      planId: "plan_growth",
      planName: "plan_growth",
      status: "active",
      teamId: null,
      teamName: null,
      agentHoursUsed: 45,
      effectiveLimit: 50,
      boostHours: 0,
      pct: 0.9,
      unmetered: false,
    })
    expect(res.users.find((u: any) => u.userId === "u_boost").billing.effectiveLimit).toBe(70)
    expect(res.users.find((u: any) => u.userId === "u_unmetered").billing.unmetered).toBe(true)
    expect(res.users.find((u: any) => u.userId === "u_nosub").billing).toBeNull()
  })
})

describe("admin.list-users — usage filter", () => {
  it("exhausted: only exhausted users, total reflects the filter, summary does not", async () => {
    const res: any = await seed()(ctx("admin1"), { usage: "exhausted" })
    expect(idsOf(res)).toEqual(["u_exhausted"])
    expect(res.total).toBe(1) // paginated total = the filtered set
    expect(res.summary.total).toBe(7) // KPI total = user-level scope (stable pivot)
    expect(res.summary.exhausted).toBe(1)
  })

  it("near: users at 80–99% of the effective limit", async () => {
    const res: any = await seed()(ctx("admin1"), { usage: "near" })
    expect(idsOf(res)).toEqual(["u_boost", "u_near"])
    expect(res.total).toBe(2)
  })

  it("has_boost: only users with an active boost", async () => {
    const res: any = await seed()(ctx("admin1"), { usage: "has_boost" })
    expect(idsOf(res)).toEqual(["u_boost"])
  })

  it("unmetered: only unlimited/unmetered subs", async () => {
    const res: any = await seed()(ctx("admin1"), { usage: "unmetered" })
    expect(idsOf(res)).toEqual(["u_unmetered"])
  })

  it("no_sub: only users without an active subscription", async () => {
    const res: any = await seed()(ctx("admin1"), { usage: "no_sub" })
    expect(idsOf(res)).toEqual(["admin1", "u_nosub"])
    expect(res.total).toBe(2)
  })

  it("an unknown usage value is ignored (behaves as no filter)", async () => {
    const res: any = await seed()(ctx("admin1"), { usage: "bogus" })
    expect(res.total).toBe(7)
  })
})

describe("admin.list-users — plan filter + combination", () => {
  it("plan: only users on that plan", async () => {
    const res: any = await seed()(ctx("admin1"), { plan: "plan_growth" })
    expect(idsOf(res)).toEqual(["u_boost", "u_exhausted", "u_low", "u_near"])
    expect(res.total).toBe(4)
  })

  it("plan + usage is an intersection", async () => {
    const res: any = await seed()(ctx("admin1"), { plan: "plan_growth", usage: "exhausted" })
    expect(idsOf(res)).toEqual(["u_exhausted"])
  })

  it("plan + no_sub is empty (a plan requires an active sub)", async () => {
    const res: any = await seed()(ctx("admin1"), { plan: "plan_growth", usage: "no_sub" })
    expect(res.users).toHaveLength(0)
    expect(res.total).toBe(0)
  })

  it("an unknown plan matches nobody", async () => {
    const res: any = await seed()(ctx("admin1"), { plan: "plan_ghost" })
    expect(res.total).toBe(0)
  })
})

describe("admin.list-users — pagination over a filtered set", () => {
  it("paginates without dropping or duplicating rows", async () => {
    const handler = seed()
    const p0: any = await handler(ctx("admin1"), { pageSize: 3, page: 0 })
    const p1: any = await handler(ctx("admin1"), { pageSize: 3, page: 1 })
    const p2: any = await handler(ctx("admin1"), { pageSize: 3, page: 2 })
    expect(p0.total).toBe(7)
    expect([p0.users.length, p1.users.length, p2.users.length]).toEqual([3, 3, 1])
    const all = [...p0.users, ...p1.users, ...p2.users].map((u: any) => u.userId)
    expect(new Set(all).size).toBe(7) // no overlap across pages
  })
})
