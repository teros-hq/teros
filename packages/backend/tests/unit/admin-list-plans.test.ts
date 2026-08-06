/**
 * admin.list-plans — the FULL plan catalogue for the admin plan picker.
 *
 * Unlike the user-facing billing.list-plans (isPublic-filtered), this returns
 * EVERY plan — including the hidden plan_unlimited — so an admin can assign it.
 * Admin/super only. Seeds the REAL BILLING_PLANS_SEED so the hidden tier is
 * exercised against the actual catalogue.
 */
import { describe, expect, test } from "bun:test"
import { createAdminListPlansHandler } from "../../src/handlers/domains/admin/list-plans"
import { BILLING_PLANS_SEED } from "../../src/models/billing"
import { InMemoryDb } from "./_stripe-test-helpers"

const ctx = (userId: string) => ({ userId }) as any

function seedCatalog(db: InMemoryDb) {
  db.seed(
    "billing_plans",
    BILLING_PLANS_SEED.map((p) => ({ ...p })),
  )
}
function fakeUserService(users: Record<string, any>) {
  return {
    async getByUserId(id: string) {
      return users[id] ?? null
    },
  } as any
}

describe("admin.list-plans", () => {
  test("admin gets the FULL catalogue, including the hidden plan_unlimited", async () => {
    const db = new InMemoryDb()
    seedCatalog(db)
    const handler = createAdminListPlansHandler(
      fakeUserService({ a: { userId: "a", role: "admin" } }),
      db as any,
    )

    const res: any = await handler(ctx("a"), {})
    const ids = res.plans.map((p: any) => p.planId)

    // Bites: filtering isPublic (like the public handler) drops the hidden tier.
    expect(ids).toContain("plan_unlimited")
    expect(ids).toContain("plan_starter") // public tiers present too
    expect(res.plans.length).toBe(BILLING_PLANS_SEED.length)

    // The hidden row carries isPublic:false so the picker can mark it.
    const hidden = res.plans.find((p: any) => p.planId === "plan_unlimited")
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
    expect(res.plans.length).toBe(BILLING_PLANS_SEED.length)
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
