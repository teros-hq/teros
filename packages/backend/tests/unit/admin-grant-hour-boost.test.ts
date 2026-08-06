/**
 * admin.grant-hour-boost / admin.revoke-hour-boost (TER-686).
 *
 * Run: bun test packages/backend/tests/unit/admin-grant-hour-boost.test.ts
 *
 * A direct admin grant of period hours is money-adjacent: BITES on authz, on the
 * boundary validation, on idempotency (a double-grant must NOT double the hours),
 * and on the invariant that the grant raises the SAME effective limit the gate
 * reads and is pinned to the current period so the reset-cron expires it. The
 * contract test fixes that grant-admin and approve-request produce the same boost
 * shape (both go through the shared insertHourBoost).
 */

import { describe, expect, it } from "bun:test"
import type { WsHandlerContext } from "@teros/shared"
import { createGetUserDetailHandler } from "../../src/handlers/domains/admin/get-user-detail"
import { createGrantHourBoostHandler } from "../../src/handlers/domains/admin/grant-hour-boost"
import { createResolveAccessRequestHandler } from "../../src/handlers/domains/admin/resolve-access-request"
import { createRevokeHourBoostHandler } from "../../src/handlers/domains/admin/revoke-hour-boost"
import {
  getActiveBoostHours,
  getBillingHourBoostsCollection,
  getEffectiveLimit,
} from "../../src/models/billing"
import { InMemoryDb } from "./_stripe-test-helpers"

const ctx = (userId: string): WsHandlerContext => ({ userId }) as any

// A wide period so a real `now` always falls inside the boost window.
const PERIOD_START = new Date("2020-01-01")
const PERIOD_END = new Date("2999-01-01")

const CALLERS: Record<string, { role: string } | undefined> = {
  admin1: { role: "admin" },
  super1: { role: "super" },
  user1: { role: "user" },
}
const userService = {
  getByUserId: async (id: string) => CALLERS[id] ?? null,
} as any

function seed(over: { planTerosModel?: boolean; agentHoursLimit?: number; used?: number } = {}) {
  const db = new InMemoryDb()
  db.seed("billing_plans", [
    {
      _id: "plan_growth",
      name: "growth",
      displayName: "Growth",
      agentHoursLimit: over.agentHoursLimit ?? 50,
      features: { terosModel: over.planTerosModel ?? true },
    },
  ])
  db.seed("billing_subscriptions", [
    {
      _id: "sub_target",
      userId: "target",
      planId: "plan_growth",
      status: "active",
      agentHoursUsed: over.used ?? 50,
      customAgentHoursLimit: null,
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
    },
  ])
  return db
}
const grant = (db: InMemoryDb) => createGrantHourBoostHandler(userService, db as any, null)
const revoke = (db: InMemoryDb) => createRevokeHourBoostHandler(userService, db as any, null)
const boostsOf = (db: InMemoryDb) => getBillingHourBoostsCollection(db as any)

describe("admin.grant-hour-boost — authz", () => {
  it("FORBIDDEN for a non-admin (code + message)", async () => {
    await expect(
      grant(seed())(ctx("user1"), { targetUserId: "target", hours: 10, idempotencyKey: "k1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "Admin privileges required" })
  })
  it("FORBIDDEN when the caller does not exist", async () => {
    await expect(
      grant(seed())(ctx("ghost"), { targetUserId: "target", hours: 10, idempotencyKey: "k1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
  it("admin and super are both allowed", async () => {
    await expect(
      grant(seed())(ctx("admin1"), { targetUserId: "target", hours: 5, idempotencyKey: "ka" }),
    ).resolves.toMatchObject({ boostId: expect.any(String), hours: 5 })
    await expect(
      grant(seed())(ctx("super1"), { targetUserId: "target", hours: 5, idempotencyKey: "ks" }),
    ).resolves.toMatchObject({ hours: 5 })
  })
})

describe("admin.grant-hour-boost — boundary validation", () => {
  const call = (data: any) => grant(seed())(ctx("admin1"), data)
  it("missing targetUserId", async () => {
    await expect(call({ hours: 10, idempotencyKey: "k" })).rejects.toMatchObject({
      code: "MISSING_FIELDS",
    })
  })
  it("rejects non-positive / non-integer / non-finite / over-max hours", async () => {
    for (const hours of [0, -5, 2.5, Number.POSITIVE_INFINITY, Number.NaN, 10001]) {
      await expect(
        call({ targetUserId: "target", hours, idempotencyKey: "k" }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
      })
    }
  })
  it("requires a well-formed idempotencyKey", async () => {
    await expect(call({ targetUserId: "target", hours: 10 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    })
    await expect(
      call({ targetUserId: "target", hours: 10, idempotencyKey: "bad key!" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" })
  })
  it("NO_SUBSCRIPTION when the user has no active sub", async () => {
    const db = new InMemoryDb() // no subs seeded
    db.seed("billing_plans", [])
    await expect(
      grant(db)(ctx("admin1"), { targetUserId: "ghost", hours: 10, idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "NO_SUBSCRIPTION" })
  })
  it("GRANT_NOT_APPLICABLE for an unmetered plan (base limit <= 0)", async () => {
    const db = seed({ agentHoursLimit: 0 }) // effective limit 0 → unmetered
    await expect(
      grant(db)(ctx("admin1"), { targetUserId: "target", hours: 10, idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "GRANT_NOT_APPLICABLE" })
  })
  it("GRANT_NOT_APPLICABLE for a non-Teros plan", async () => {
    const db = seed({ planTerosModel: false })
    await expect(
      grant(db)(ctx("admin1"), { targetUserId: "target", hours: 10, idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "GRANT_NOT_APPLICABLE" })
  })
})

describe("admin.grant-hour-boost — grant effects", () => {
  it("creates an active boost pinned to the period, audited, that raises the effective limit", async () => {
    const db = seed({ agentHoursLimit: 50, used: 50 })
    const res: any = await grant(db)(ctx("admin1"), {
      targetUserId: "target",
      hours: 20,
      note: "  extra for launch  ",
      idempotencyKey: "k1",
    })
    expect(res).toMatchObject({ targetUserId: "target", hours: 20, deduped: false })

    const docs = boostsOf(db).docs as any[]
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({
      _id: "admin-grant:target:k1",
      userId: "target",
      subscriptionId: "sub_target",
      hours: 20,
      status: "active",
      grantedBy: "admin1", // audit trail: who granted
      accessRequestId: null,
      source: "admin_grant",
      note: "extra for launch", // trimmed
    })
    // Pinned to the CURRENT period so the reset-cron sweeps it at rollover.
    expect(docs[0].periodStart).toEqual(PERIOD_START)
    expect(docs[0].periodEnd).toEqual(PERIOD_END)

    // Raises the SAME effective limit the gate reads (50 base + 20 boost = 70).
    const boostHours = await getActiveBoostHours(db as any, "sub_target", new Date())
    expect(boostHours).toBe(20)
    expect(
      getEffectiveLimit({ customAgentHoursLimit: null }, { agentHoursLimit: 50 }, boostHours),
    ).toBe(70)
  })

  it("is idempotent: a re-grant with the same key does not double the hours", async () => {
    const db = seed()
    const args = { targetUserId: "target", hours: 20, idempotencyKey: "dup" }
    const r1: any = await grant(db)(ctx("admin1"), args)
    const r2: any = await grant(db)(ctx("admin1"), args)
    expect(r1.deduped).toBe(false)
    expect(r2.deduped).toBe(true)
    expect(r2.boostId).toBe(r1.boostId)
    expect(boostsOf(db).docs).toHaveLength(1)
    expect(await getActiveBoostHours(db as any, "sub_target", new Date())).toBe(20) // NOT 40
  })

  it("stops counting once expired (proves it does not persist past the period)", async () => {
    const db = seed()
    await grant(db)(ctx("admin1"), { targetUserId: "target", hours: 20, idempotencyKey: "k" })
    // Simulate what the reset-cron does at rollover.
    ;(boostsOf(db).docs[0] as any).status = "expired"
    expect(await getActiveBoostHours(db as any, "sub_target", new Date())).toBe(0)
  })
})

describe("admin.revoke-hour-boost", () => {
  async function seedWithBoost() {
    const db = seed()
    await grant(db)(ctx("admin1"), { targetUserId: "target", hours: 20, idempotencyKey: "k" })
    return db
  }
  it("FORBIDDEN for a non-admin", async () => {
    const db = await seedWithBoost()
    await expect(
      revoke(db)(ctx("user1"), { targetUserId: "target", boostId: "admin-grant:target:k" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
  it("revokes an active boost, records revokedBy, drops the effective limit", async () => {
    const db = await seedWithBoost()
    const res: any = await revoke(db)(ctx("admin1"), {
      targetUserId: "target",
      boostId: "admin-grant:target:k",
    })
    expect(res).toMatchObject({ status: "revoked", hours: 20 })
    const doc = (boostsOf(db).docs as any[])[0]
    expect(doc.status).toBe("revoked")
    expect(doc.revokedBy).toBe("admin1")
    expect(await getActiveBoostHours(db as any, "sub_target", new Date())).toBe(0)
  })
  it("NOT_FOUND for a wrong id, wrong user, or an already-revoked boost", async () => {
    const db = await seedWithBoost()
    await expect(
      revoke(db)(ctx("admin1"), { targetUserId: "target", boostId: "nope" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(
      revoke(db)(ctx("admin1"), { targetUserId: "other", boostId: "admin-grant:target:k" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    await revoke(db)(ctx("admin1"), { targetUserId: "target", boostId: "admin-grant:target:k" })
    await expect(
      revoke(db)(ctx("admin1"), { targetUserId: "target", boostId: "admin-grant:target:k" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" }) // second revoke is a no-op
  })
  it("MISSING_FIELDS without targetUserId or boostId", async () => {
    const db = await seedWithBoost()
    await expect(revoke(db)(ctx("admin1"), { boostId: "x" })).rejects.toMatchObject({
      code: "MISSING_FIELDS",
    })
    await expect(revoke(db)(ctx("admin1"), { targetUserId: "target" })).rejects.toMatchObject({
      code: "MISSING_FIELDS",
    })
  })
})

describe("get-user-detail — boost-aware effective limit (TER-687)", () => {
  const detailOf = (db: InMemoryDb) => createGetUserDetailHandler(userService, db as any)
  it("includes active period boosts in effectiveLimit + boostHours", async () => {
    const db = seed({ agentHoursLimit: 50, used: 20 })
    await grant(db)(ctx("admin1"), { targetUserId: "target", hours: 30, idempotencyKey: "k" })
    const detail: any = await detailOf(db)(ctx("admin1"), { targetUserId: "target" })
    // BITE: reverting get-user-detail to the base limit → 50/undefined → red.
    expect(detail.billing.effectiveLimit).toBe(80) // 50 base + 30 boost
    expect(detail.billing.boostHours).toBe(30)
  })
  it("boostHours 0 + base limit when there is no active boost", async () => {
    const detail: any = await detailOf(seed({ agentHoursLimit: 50 }))(ctx("admin1"), {
      targetUserId: "target",
    })
    expect(detail.billing.effectiveLimit).toBe(50)
    expect(detail.billing.boostHours).toBe(0)
  })
})

describe("contract: grant-admin and approve-request produce the same boost shape", () => {
  it("both go through insertHourBoost → identical field set, differing only in _id/accessRequestId/source", async () => {
    const db = seed()
    // Direct admin grant.
    await grant(db)(ctx("admin1"), { targetUserId: "target", hours: 20, idempotencyKey: "k" })
    // Access-request approval for the SAME user/sub.
    db.seed("billing_access_requests", [
      { _id: "req1", userId: "target", type: "boost", status: "pending", requestedHours: 20 },
    ])
    const resolve = createResolveAccessRequestHandler(userService, db as any, null, null)
    await resolve(ctx("admin1"), { requestId: "req1", action: "approve" })

    const docs = boostsOf(db).docs as any[]
    const adminGrant = docs.find((b) => b.source === "admin_grant")
    const reqGrant = docs.find((b) => b.source === "access_request")
    expect(adminGrant && reqGrant).toBeTruthy()
    // Same set of keys.
    expect(Object.keys(adminGrant).sort()).toEqual(Object.keys(reqGrant).sort())
    // Same structural fields; only origin identity differs.
    for (const k of ["userId", "subscriptionId", "hours", "status", "periodStart", "periodEnd"]) {
      expect(adminGrant[k]).toEqual(reqGrant[k])
    }
    expect(adminGrant.accessRequestId).toBeNull()
    expect(reqGrant.accessRequestId).toBe("req1")
  })
})
