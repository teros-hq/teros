/**
 * G0 — Plan catalogue (TER-596 / TER-597). `billing.list-plans` is the single
 * source the web (onboarding PlanStep + Profile PricingCards) renders, so the
 * load-bearing numbers (price / included hours / Popular + Contact-sales badges)
 * must match the catalogue decided on teros.ai. Asserted exactly AND cross-checked
 * against the raw `billing_plans` collection so a pickFields drop or a hardcoded
 * value can't pass.
 *
 * Bite: change any price/hours in the seed/migration, drop the `popular` flag, or
 * forget `contactSales` on Enterprise → red.
 */
import { closeDb } from "../helpers/db"
import { getPlan } from "../helpers/billing"
import { wsRequest } from "../helpers/teros"
import { expect, test } from "../fixtures"

interface PlanView {
  planId: string
  displayName: string
  price: number
  agentHoursLimit: number
  popular: boolean
  contactSales: boolean
}

// The catalogue (teros.ai/en) — the 5 real tiers with their load-bearing numbers.
const EXPECTED: Record<
  string,
  { displayName: string; price: number; hours: number; popular: boolean; contactSales: boolean }
> = {
  plan_starter: { displayName: "Starter", price: 0, hours: 10, popular: false, contactSales: false },
  plan_growth: { displayName: "Growth", price: 89, hours: 40, popular: true, contactSales: false },
  plan_pro: { displayName: "Pro", price: 179, hours: 80, popular: false, contactSales: false },
  plan_ultra: { displayName: "Ultra", price: 349, hours: 200, popular: false, contactSales: false },
  plan_enterprise: {
    displayName: "Enterprise",
    price: 0,
    hours: 0,
    popular: false,
    contactSales: true,
  },
}

test.afterAll(async () => {
  await closeDb()
})

test.describe("billing — catálogo de planes G0 @billing", () => {
  test("list-plans expone los 5 tiers con precio/horas/badges exactos", async ({ terosPage }) => {
    const { plans } = await wsRequest<{ plans: PlanView[] }>(terosPage, "billing.list-plans")
    const byId = new Map(plans.map((p) => [p.planId, p]))

    // Exactamente los 5 planes del catálogo — ni retirados (basic/max/infinity) ni de más.
    expect([...byId.keys()].sort(), "set exacto de planIds").toEqual(Object.keys(EXPECTED).sort())

    for (const [planId, exp] of Object.entries(EXPECTED)) {
      const p = byId.get(planId)
      expect(p, planId).toBeTruthy()
      if (!p) continue
      expect(p.displayName, `${planId}.displayName`).toBe(exp.displayName)
      expect(p.price, `${planId}.price`).toBe(exp.price)
      expect(p.agentHoursLimit, `${planId}.agentHoursLimit`).toBe(exp.hours)
      expect(Boolean(p.popular), `${planId}.popular`).toBe(exp.popular)
      expect(Boolean(p.contactSales), `${planId}.contactSales`).toBe(exp.contactSales)
    }

    // Solo Growth lleva el badge Popular.
    expect(
      plans.filter((p) => p.popular).map((p) => p.planId),
      "único plan Popular",
    ).toEqual(["plan_growth"])

    // Contact-sales va el último en el orden de display.
    expect(plans[plans.length - 1]?.planId, "Enterprise (contact-sales) al final").toBe(
      "plan_enterprise",
    )
  })

  test("la API espeja billing_plans (no hardcodea ni dropea campos visuales)", async ({
    terosPage,
  }) => {
    const { plans } = await wsRequest<{ plans: PlanView[] }>(terosPage, "billing.list-plans")
    // Growth lleva el flag visual `popular` — el que más se pierde en un pickFields.
    const growthApi = plans.find((p) => p.planId === "plan_growth")
    const growthDb = (await getPlan("plan_growth")) as {
      price: number
      agentHoursLimit: number
      popular: boolean
    } | null
    expect(growthApi, "growth en la API").toBeTruthy()
    expect(growthDb, "growth en billing_plans").toBeTruthy()
    if (!growthApi || !growthDb) return
    expect(growthApi.price).toBe(growthDb.price)
    expect(growthApi.agentHoursLimit).toBe(growthDb.agentHoursLimit)
    expect(growthApi.popular).toBe(growthDb.popular)
  })
})
