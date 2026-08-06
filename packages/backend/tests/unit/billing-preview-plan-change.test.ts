/**
 * TER-596 I3 — billing.preview-plan-change (read-only quote before commit).
 *
 * The assertions that bite: the preview must use the SAME upgrade/downgrade rule
 * and the SAME proration formula as billing.change-plan, so it can never lie
 * about what will be charged. We pin the EXACT amounts:
 *   - upgrade → prorationAmount === computeProrationUpgradeCharge(.., now) where
 *     `now` is recovered from the returned effectiveDate (the handler's own now);
 *   - downgrade → prorationAmount 0 + effectiveDate === currentPeriodEnd;
 *   - lateral (customPrice override == new price) → upgrade, prorationAmount 0
 *     (proves getEffectivePrice honours the override, not the list price);
 *   - validation: INVALID_INPUT / INVALID_PLAN / CONTACT_SALES / NO_SUBSCRIPTION.
 */
import { describe, expect, test } from "bun:test"
import type { Db } from "mongodb"
import { createPreviewPlanChangeHandler } from "../../src/handlers/domains/billing/preview-plan-change"
import { computeProrationUpgradeCharge } from "../../src/models/billing"
import { InMemoryDb } from "./_stripe-test-helpers"

const ctx = (userId: string) => ({ userId }) as any
const D = (iso: string) => new Date(iso)

function seedPlans(db: InMemoryDb) {
  const plan = (over: Record<string, any>) => ({
    name: over._id, displayName: over._id, description: "", currency: "EUR",
    features: { terosModel: true, byok: true, maxWorkspaces: -1, prioritySupport: true },
    isPublic: true, contactSales: false, ...over,
  })
  db.seed("billing_plans", [
    plan({ _id: "plan_starter", displayName: "Starter", price: 0, agentHoursLimit: 10 }),
    plan({ _id: "plan_growth", displayName: "Growth", price: 89, agentHoursLimit: 40 }),
    plan({ _id: "plan_pro", displayName: "Pro", price: 179, agentHoursLimit: 80 }),
    plan({ _id: "plan_enterprise", displayName: "Enterprise", price: 0, agentHoursLimit: 0, contactSales: true }),
    plan({ _id: "plan_private", displayName: "Private", price: 50, agentHoursLimit: 5, isPublic: false }),
  ])
}

function seedSub(db: InMemoryDb, over: Record<string, any> = {}) {
  db.seed("billing_subscriptions", [
    {
      _id: "sub1", userId: "u1", planId: "plan_growth", customAgentHoursLimit: null,
      customPrice: null, customPriceNote: null, agentHoursUsed: 12, overageHours: 0,
      currentPeriodStart: D("2026-06-01"), currentPeriodEnd: D("2030-01-01"),
      status: "active", startDate: D("2026-06-01"), endDate: null, cancelAtPeriodEnd: false,
      scheduledPlanChange: null, paymentMethod: "stripe", billingNotes: "", teamId: null,
      terosProviderConfigId: null, createdAt: D("2026-06-01"), updatedAt: D("2026-06-01"),
      ...over,
    },
  ])
}

function mkEnv(over: { sub?: Record<string, any>; noSub?: boolean } = {}) {
  const db = new InMemoryDb()
  seedPlans(db)
  if (!over.noSub) seedSub(db, over.sub)
  return { db, handler: createPreviewPlanChangeHandler(db as unknown as Db) }
}

describe("billing.preview-plan-change", () => {
  test("upgrade: exact prorated amount (recovered now matches the formula)", async () => {
    const { handler } = mkEnv()
    const res = await handler(ctx("u1"), { planId: "plan_pro" })

    expect(res.kind).toBe("upgrade")
    expect(res.newPrice).toBe(179)
    expect(res.currentPlanName).toBe("Growth")
    expect(res.newPlanName).toBe("Pro")

    // effectiveDate IS the handler's `now` for an upgrade → reconstruct it and
    // assert the charge equals the canonical formula EXACTLY. A mutation that
    // returned the full diff (90) instead of the prorated value would fail.
    const now = new Date(res.effectiveDate)
    const expected = computeProrationUpgradeCharge(
      { customPrice: null, currentPeriodStart: D("2026-06-01"), currentPeriodEnd: D("2030-01-01") },
      { price: 89 },
      179,
      now,
    )
    expect(res.prorationAmount).toBe(expected)
    expect(res.prorationAmount).toBeGreaterThan(0)
  })

  test("downgrade: zero charge, deferred to the period end", async () => {
    const { handler } = mkEnv()
    const res = await handler(ctx("u1"), { planId: "plan_starter" })

    expect(res.kind).toBe("downgrade")
    expect(res.prorationAmount).toBe(0)
    expect(res.effectiveDate).toBe(D("2030-01-01").toISOString())
    expect(res.currentPlanName).toBe("Growth")
    expect(res.newPlanName).toBe("Starter")
  })

  test("lateral via customPrice override: upgrade kind, zero charge (override honoured)", async () => {
    // Sub overrides price to 179 → equal to Pro's list price → not a downgrade,
    // and diff 0 → no charge. If getEffectivePrice ignored customPrice, oldPrice
    // would be 89 < 179 and prorationAmount would be > 0.
    const { handler } = mkEnv({ sub: { customPrice: 179 } })
    const res = await handler(ctx("u1"), { planId: "plan_pro" })

    expect(res.kind).toBe("upgrade")
    expect(res.prorationAmount).toBe(0)
  })

  test("rejects a missing planId (INVALID_INPUT)", async () => {
    const { handler } = mkEnv()
    const err = await handler(ctx("u1"), {}).catch((e) => e)
    expect(err.code).toBe("INVALID_INPUT")
  })

  test("rejects an unknown / non-public plan (INVALID_PLAN)", async () => {
    const { handler } = mkEnv()
    expect((await handler(ctx("u1"), { planId: "plan_nope" }).catch((e) => e)).code).toBe("INVALID_PLAN")
    // isPublic:false is also not self-serve.
    expect((await handler(ctx("u1"), { planId: "plan_private" }).catch((e) => e)).code).toBe("INVALID_PLAN")
  })

  test("rejects a contact-sales plan (CONTACT_SALES)", async () => {
    const { handler } = mkEnv()
    const err = await handler(ctx("u1"), { planId: "plan_enterprise" }).catch((e) => e)
    expect(err.code).toBe("CONTACT_SALES")
  })

  test("rejects when the user has no active subscription (NO_SUBSCRIPTION)", async () => {
    const { handler } = mkEnv({ noSub: true })
    const err = await handler(ctx("u1"), { planId: "plan_pro" }).catch((e) => e)
    expect(err.code).toBe("NO_SUBSCRIPTION")
  })
})
