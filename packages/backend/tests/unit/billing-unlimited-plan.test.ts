/**
 * TER-633 — the hidden `plan_unlimited` tier.
 *
 * Invariant under test: plan_unlimited is UNMETERED (like Enterprise) and
 * assignable ONLY by an admin — it must never be visible nor self-selectable
 * through any self-serve path. Seeds the REAL BILLING_PLANS_SEED so the test
 * exercises the actual catalogue shape, not a hand-rolled fixture.
 *
 * Each assertion is pinned to the mutation it catches (e.g. making the plan
 * public, or dropping an isPublic filter from a self-serve handler).
 */
import { describe, expect, test } from "bun:test"
import { createUpdateBillingSubscriptionHandler } from "../../src/handlers/domains/admin/update-billing-subscription"
import { createChangePlanHandler } from "../../src/handlers/domains/billing/change-plan"
import { createListPlansHandler } from "../../src/handlers/domains/billing/list-plans"
import { createPreviewPlanChangeHandler } from "../../src/handlers/domains/billing/preview-plan-change"
import { createRequestAccessHandler } from "../../src/handlers/domains/billing/request-access"
import { BILLING_PLANS_SEED, STARTER_PLAN_ID } from "../../src/models/billing"
import { BillingGateService } from "../../src/services/billing-gate"
import { InMemoryDb } from "./_stripe-test-helpers"

const ctx = (userId: string) => ({ userId }) as any
const D = (iso: string) => new Date(iso)

function seedCatalog(db: InMemoryDb) {
  db.seed(
    "billing_plans",
    BILLING_PLANS_SEED.map((p) => ({ ...p })),
  )
}

function activeSub(userId: string, planId: string, over: Record<string, any> = {}) {
  return {
    _id: `sub_${userId}`,
    userId,
    planId,
    customAgentHoursLimit: null,
    customPrice: null,
    customPriceNote: null,
    agentHoursUsed: 0,
    overageHours: 0,
    currentPeriodStart: D("2026-06-01"),
    currentPeriodEnd: D("2026-07-01"),
    status: "active",
    startDate: D("2026-06-01"),
    endDate: null,
    cancelAtPeriodEnd: false,
    scheduledPlanChange: null,
    paymentMethod: "manual",
    billingNotes: "",
    teamId: null,
    terosProviderConfigId: null,
    createdAt: D("2026-06-01"),
    updatedAt: D("2026-06-01"),
    ...over,
  }
}

function fakeUserService(users: Record<string, any>) {
  return {
    async getByUserId(id: string) {
      return users[id] ?? null
    },
    async listUsers({ role }: { role?: string } = {}) {
      const us = Object.values(users).filter((u: any) => !role || u.role === role)
      return { users: us, total: us.length }
    },
  } as any
}

describe("plan_unlimited — hidden, unmetered, admin-only", () => {
  test("gate: a plan_unlimited sub is unmetered (no block even at huge usage)", async () => {
    const db = new InMemoryDb()
    seedCatalog(db)
    db.seed("billing_subscriptions", [activeSub("u", "plan_unlimited", { agentHoursUsed: 99_999 })])
    const gate = new BillingGateService(db as any)

    // Must NOT throw despite 99_999h used — unmetered like Enterprise. Bites:
    // giving plan_unlimited a positive agentHoursLimit would throw HOURS_EXHAUSTED.
    await gate.assertHoursAvailable("u")

    expect(await gate.canUseTerosModel("u")).toBe(true) // bites: terosModel:false
    const features = await gate.getSubscriptionFeatures("u")
    expect(features?.agentHoursLimit).toBe(0) // unmetered ⇒ limit <= 0
  })

  test("list-plans never returns plan_unlimited (but does return the public tiers)", async () => {
    const db = new InMemoryDb()
    seedCatalog(db)
    const res: any = await createListPlansHandler(db as any)(ctx("u"), {})
    const ids = res.plans.map((p: any) => p.planId)

    expect(ids).not.toContain("plan_unlimited") // bites: making it public
    expect(ids).toContain("plan_starter") // sanity: public tiers DO show
    expect(ids).toContain("plan_enterprise")
  })

  test("change-plan refuses plan_unlimited (INVALID_PLAN — not self-serve)", async () => {
    const db = new InMemoryDb()
    seedCatalog(db)
    db.seed("billing_subscriptions", [activeSub("u", STARTER_PLAN_ID)])
    const handler = createChangePlanHandler(db as any, null) // Stripe disabled

    await expect(handler(ctx("u"), { planId: "plan_unlimited" })).rejects.toMatchObject({
      code: "INVALID_PLAN",
    })
    // The user's plan is unchanged — the hidden tier was not granted.
    const sub = db.collection("billing_subscriptions").docs.find((s) => s.userId === "u")
    expect(sub?.planId).toBe(STARTER_PLAN_ID)
  })

  test("preview-plan-change refuses plan_unlimited (INVALID_PLAN)", async () => {
    const db = new InMemoryDb()
    seedCatalog(db)
    db.seed("billing_subscriptions", [activeSub("u", STARTER_PLAN_ID)])
    const handler = createPreviewPlanChangeHandler(db as any)

    await expect(handler(ctx("u"), { planId: "plan_unlimited" })).rejects.toMatchObject({
      code: "INVALID_PLAN",
    })
  })

  test("request-access refuses an upgrade to plan_unlimited (INVALID_PLAN)", async () => {
    const db = new InMemoryDb()
    seedCatalog(db)
    db.seed("billing_subscriptions", [activeSub("u", STARTER_PLAN_ID)])
    const handler = createRequestAccessHandler(
      db as any,
      fakeUserService({ u: { userId: "u", role: "user", profile: {} } }),
      null,
    )

    await expect(
      handler(ctx("u"), { type: "upgrade", requestedPlanId: "plan_unlimited" }),
    ).rejects.toMatchObject({ code: "INVALID_PLAN" })
    // Nothing was persisted — the user cannot even nominate the hidden tier.
    expect(db.collection("billing_access_requests").docs).toHaveLength(0)
  })

  test("admin.update-billing-subscription CAN assign plan_unlimited", async () => {
    const db = new InMemoryDb()
    seedCatalog(db)
    db.seed("billing_subscriptions", [activeSub("target", STARTER_PLAN_ID)])
    const handler = createUpdateBillingSubscriptionHandler(
      fakeUserService({
        admin: { userId: "admin", role: "admin", profile: {} },
        target: { userId: "target", role: "user", profile: {} },
      }),
      db as any,
      null,
    )

    const res: any = await handler(ctx("admin"), {
      targetUserId: "target",
      planId: "plan_unlimited",
    })

    // Admin path does NOT filter isPublic → the hidden tier IS assignable.
    expect(res.subscription.planId).toBe("plan_unlimited")
    const active = db
      .collection("billing_subscriptions")
      .docs.find((s) => s.userId === "target" && s.status === "active")
    expect(active?.planId).toBe("plan_unlimited")
  })
})
