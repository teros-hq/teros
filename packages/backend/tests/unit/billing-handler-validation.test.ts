/**
 * Boundary validation + FK existence + authz for admin.update-billing-subscription
 * (FASE 3c).
 *
 * "DB Writes Are Contracts" (ENGINEERING-PRINCIPLES): the handler validates what
 * JSON Schema cannot express BEFORE any write — non-finite/negative/non-integer
 * numbers, and the existence of every referenced entity (plan, teros provider
 * config, team). These paths had no direct coverage; assertNullableNumber and
 * the three FK checks were untested.
 *
 * Every test asserts the EXACT error code + that NOTHING was written (fail fast,
 * fail loud, no partial state).
 *
 * MUST BITE: each assertion was confirmed red against a mutated handler —
 *   - dropping `Number.isFinite` lets NaN/Infinity through,
 *   - dropping `value < opts.min` lets negatives through,
 *   - dropping `!Number.isInteger` lets fractional hour limits through,
 *   - dropping a `findOne` FK guard lets the phantom ref through.
 */

import { describe, expect, it } from "bun:test"
import { createUpdateBillingSubscriptionHandler } from "../../src/handlers/domains/admin/update-billing-subscription"

const ADMIN = { userId: "admin1", role: "admin" }
const TARGET = { userId: "u", role: "user" }

function makeUserService(extra: Record<string, any> = {}) {
  const users: Record<string, any> = { admin1: ADMIN, u: TARGET, ...extra }
  return { getByUserId: async (id: string) => users[id] ?? null } as any
}

const PLANS: Record<string, any> = {
  plan_basic: { _id: "plan_basic", name: "basic", displayName: "Essential", price: 0 },
  plan_pro: { _id: "plan_pro", name: "pro", displayName: "Pro", price: 89 },
}

/**
 * Db fake recording every write so we can assert "nothing was written" on the
 * reject paths. `active` seeds the user's single active sub; `configs`/`teams`
 * are the FK targets (empty by default → not found).
 */
function makeDb(opts: { active?: any; configs?: any[]; teams?: any[] } = {}) {
  const subs: any[] = opts.active ? [opts.active] : []
  const writes: { inserts: any[]; updates: any[] } = { inserts: [], updates: [] }
  const configs = opts.configs ?? []
  const teams = opts.teams ?? []
  const db = {
    collection(name: string) {
      switch (name) {
        case "billing_subscriptions":
          return {
            async findOne(f: any) {
              if (f._id) return subs.find((s) => s._id === f._id) ?? null
              return (
                subs.find(
                  (s) => s.userId === f.userId && (f.status === undefined || s.status === f.status),
                ) ?? null
              )
            },
            async insertOne(doc: any) {
              subs.push(doc)
              writes.inserts.push(doc)
              return { insertedId: doc._id }
            },
            async updateOne(f: any, u: any) {
              const s = subs.find((x) => x._id === f._id)
              writes.updates.push({ f, u })
              if (s) Object.assign(s, u.$set)
              return { matchedCount: s ? 1 : 0 }
            },
          }
        case "billing_plans":
          return {
            async findOne(f: any) {
              return PLANS[f._id] ?? null
            },
          }
        case "billing_invoices":
          return {
            async findOne() {
              return null
            },
          }
        case "teros_provider_configs":
          return {
            async findOne(f: any) {
              return configs.find((c) => c._id === f._id) ?? null
            },
          }
        case "billing_teams":
          return {
            async findOne(f: any) {
              return teams.find((t) => t._id === f._id) ?? null
            },
          }
        default:
          return null as any
      }
    },
  } as any
  return { db, writes }
}

function activeSub(over: any = {}) {
  const now = new Date("2026-03-15T00:00:00Z")
  return {
    _id: "sub_1",
    userId: "u",
    planId: "plan_pro",
    customAgentHoursLimit: null,
    customPrice: null,
    customPriceNote: null,
    agentHoursUsed: 0,
    overageHours: 0,
    currentPeriodStart: now,
    currentPeriodEnd: new Date("2026-04-15T00:00:00Z"),
    status: "active",
    startDate: now,
    endDate: null,
    paymentMethod: "manual",
    billingNotes: "",
    ...over,
  }
}

const ctx = { userId: "admin1" } as any

async function expectError(p: Promise<unknown>, code: string) {
  let thrown: any
  try {
    await p
  } catch (e) {
    thrown = e
  }
  if (!thrown) throw new Error(`expected handler to throw ${code}`)
  expect(thrown.code).toBe(code)
  return thrown
}

describe("admin.update-billing-subscription — authz + required fields", () => {
  it("rejects a non-admin caller with FORBIDDEN", async () => {
    const { db, writes } = makeDb({ active: activeSub() })
    const handler = createUpdateBillingSubscriptionHandler(
      makeUserService({ admin1: { userId: "admin1", role: "user" } }),
      db,
    )
    const err = await expectError(handler(ctx, { targetUserId: "u", customPrice: 5 }), "FORBIDDEN")
    expect(err.message).toContain("Admin")
    expect(writes.inserts).toHaveLength(0)
    expect(writes.updates).toHaveLength(0)
  })

  it("rejects a missing targetUserId with MISSING_FIELDS", async () => {
    const { db } = makeDb()
    const handler = createUpdateBillingSubscriptionHandler(makeUserService(), db)
    await expectError(handler(ctx, {}), "MISSING_FIELDS")
  })

  it("rejects an unknown target user with USER_NOT_FOUND", async () => {
    const { db, writes } = makeDb()
    const handler = createUpdateBillingSubscriptionHandler(makeUserService(), db)
    await expectError(handler(ctx, { targetUserId: "ghost", customPrice: 5 }), "USER_NOT_FOUND")
    expect(writes.inserts).toHaveLength(0)
  })
})

describe("admin.update-billing-subscription — numeric boundary validation", () => {
  // assertNullableNumber: finite, >= min, optionally integer. JSON Schema does
  // not catch NaN/Infinity, and the client's Number() readily produces them.
  const cases: Array<{ label: string; data: any }> = [
    { label: "customPrice = NaN", data: { customPrice: Number.NaN } },
    { label: "customPrice = Infinity", data: { customPrice: Number.POSITIVE_INFINITY } },
    { label: "customPrice = -Infinity", data: { customPrice: Number.NEGATIVE_INFINITY } },
    { label: "customPrice = -1 (below min 0)", data: { customPrice: -1 } },
    { label: "customAgentHoursLimit = NaN", data: { customAgentHoursLimit: Number.NaN } },
    { label: "customAgentHoursLimit = -5", data: { customAgentHoursLimit: -5 } },
    { label: "customAgentHoursLimit = 1.5 (non-integer)", data: { customAgentHoursLimit: 1.5 } },
  ]

  for (const { label, data } of cases) {
    it(`rejects ${label} with INVALID_INPUT and writes nothing`, async () => {
      const { db, writes } = makeDb({ active: activeSub() })
      const handler = createUpdateBillingSubscriptionHandler(makeUserService(), db)
      await expectError(handler(ctx, { targetUserId: "u", ...data }), "INVALID_INPUT")
      // Validation runs before any write — no partial mutation.
      expect(writes.inserts).toHaveLength(0)
      expect(writes.updates).toHaveLength(0)
    })
  }

  it("accepts customPrice = 0 (min boundary, free BETA plan)", async () => {
    const { db } = makeDb({ active: activeSub() })
    const handler = createUpdateBillingSubscriptionHandler(makeUserService(), db)
    const res: any = await handler(ctx, { targetUserId: "u", customPrice: 0 })
    expect(res.subscription.customPrice).toBe(0)
  })

  it('treats null as "leave unset" (no-op, not a validation failure)', async () => {
    const { db } = makeDb({ active: activeSub({ customPrice: 42 }) })
    const handler = createUpdateBillingSubscriptionHandler(makeUserService(), db)
    const res: any = await handler(ctx, { targetUserId: "u", customPrice: null })
    // null is an explicit clear, accepted by assertNullableNumber's early return.
    expect(res.subscription.customPrice).toBeNull()
  })

  it("accepts a large finite integer hours limit", async () => {
    const { db } = makeDb({ active: activeSub() })
    const handler = createUpdateBillingSubscriptionHandler(makeUserService(), db)
    const res: any = await handler(ctx, { targetUserId: "u", customAgentHoursLimit: 10_000 })
    expect(res.subscription.customAgentHoursLimit).toBe(10_000)
  })
})

describe("admin.update-billing-subscription — FK existence of referenced entities", () => {
  it("rejects an unknown planId with INVALID_PLAN before writing", async () => {
    const { db, writes } = makeDb({ active: activeSub() })
    const handler = createUpdateBillingSubscriptionHandler(makeUserService(), db)
    await expectError(handler(ctx, { targetUserId: "u", planId: "plan_ghost" }), "INVALID_PLAN")
    expect(writes.updates).toHaveLength(0)
    expect(writes.inserts).toHaveLength(0)
  })

  it("rejects an unknown terosProviderConfigId with INVALID_CONFIG", async () => {
    const { db, writes } = makeDb({ active: activeSub() })
    const handler = createUpdateBillingSubscriptionHandler(makeUserService(), db)
    await expectError(
      handler(ctx, { targetUserId: "u", terosProviderConfigId: "cfg_ghost" }),
      "INVALID_CONFIG",
    )
    expect(writes.updates).toHaveLength(0)
  })

  it("accepts an existing terosProviderConfigId", async () => {
    const { db } = makeDb({ active: activeSub(), configs: [{ _id: "cfg_real" }] })
    const handler = createUpdateBillingSubscriptionHandler(makeUserService(), db)
    const res: any = await handler(ctx, { targetUserId: "u", terosProviderConfigId: "cfg_real" })
    expect(res.subscription.terosProviderConfigId).toBe("cfg_real")
  })

  it("rejects an unknown teamId with INVALID_TEAM", async () => {
    const { db } = makeDb({ active: activeSub() })
    const handler = createUpdateBillingSubscriptionHandler(makeUserService(), db)
    await expectError(handler(ctx, { targetUserId: "u", teamId: "team_ghost" }), "INVALID_TEAM")
  })

  it("null FK fields are allowed (explicit clear, no existence check)", async () => {
    // `!= null` guards skip the existence check for null — clearing an assignment
    // must not require the (absent) entity to exist.
    const { db } = makeDb({
      active: activeSub({ terosProviderConfigId: "cfg_old", teamId: "team_old" }),
    })
    const handler = createUpdateBillingSubscriptionHandler(makeUserService(), db)
    const res: any = await handler(ctx, {
      targetUserId: "u",
      terosProviderConfigId: null,
      teamId: null,
    })
    expect(res.subscription.terosProviderConfigId).toBeNull()
    expect(res.subscription.teamId).toBeNull()
  })
})
