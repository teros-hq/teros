/**
 * admin.list-plans — the FULL plan catalogue for the admin plan picker.
 *
 * Unlike the user-facing billing.list-plans (isPublic-filtered), this returns
 * EVERY plan — including any hidden tier (isPublic:false) — so an admin can
 * assign it. Admin/super only. Seeds the REAL BILLING_PLANS_SEED plus a fixture
 * hidden tier (the seed itself has none since plan_unlimited was retired).
 */
import { describe, expect, test } from "bun:test"
import { createAdminListPlansHandler } from "../../src/handlers/domains/admin/list-plans"
import { BILLING_PLANS_SEED } from "../../src/models/billing"
import { InMemoryDb } from "./_stripe-test-helpers"

const ctx = (userId: string) => ({ userId }) as any

// Fixture hidden tier — inserted by the test, never part of the seed.
const HIDDEN = "plan_hidden_test"

function seedCatalog(db: InMemoryDb) {
  db.seed("billing_plans", [
    ...BILLING_PLANS_SEED.map((p) => ({ ...p })),
    { ...BILLING_PLANS_SEED[0], _id: HIDDEN, name: "hidden_test", displayName: "Hidden (test)", isPublic: false },
  ])
}
function fakeUserService(users: Record<string, any>) {
  return {
    async getByUserId(id: string) {
      return users[id] ?? null
    },
  } as any
}

describe("admin.list-plans", () => {
  test("admin gets the FULL catalogue, including a hidden tier", async () => {
    const db = new InMemoryDb()
    seedCatalog(db)
    const handler = createAdminListPlansHandler(
      fakeUserService({ a: { userId: "a", role: "admin" } }),
      db as any,
    )

    const res: any = await handler(ctx("a"), {})
    const ids = res.plans.map((p: any) => p.planId)

    // Bites: filtering isPublic (like the public handler) drops the hidden tier.
    expect(ids).toContain(HIDDEN)
    expect(ids).toContain("plan_starter") // public tiers present too
    expect(res.plans.length).toBe(BILLING_PLANS_SEED.length + 1)

    // The hidden row carries isPublic:false so the picker can mark it.
    const hidden = res.plans.find((p: any) => p.planId === HIDDEN)
    expect(hidden.isPublic).toBe(false)
  })

  test("a super admin is allowed too", async () => {
    const db = new InMemoryDb()
    seedCatalog(db)
    const handler = createAdminListPlansHandler(
      fakeUserService({ s: { userId: "s", role: "super" } }),
      db as any,
    )
    const res: any = await handler(ctx("s"), {})
    expect(res.plans.length).toBe(BILLING_PLANS_SEED.length + 1)
  })

  test("a non-admin is refused (FORBIDDEN)", async () => {
    const db = new InMemoryDb()
    seedCatalog(db)
    const handler = createAdminListPlansHandler(
      fakeUserService({ u: { userId: "u", role: "user" } }),
      db as any,
    )
    await expect(handler(ctx("u"), {})).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})
