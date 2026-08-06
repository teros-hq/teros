/**
 * TER-596 I3 — billing.get-subscription now also returns the default payment
 * method (brand/last4/exp) so the profile can show "Visa ···· 4242".
 *
 * The assertions that bite:
 *   - card present → exact {brand,last4,expMonth,expYear} from Stripe;
 *   - no vaulted method → paymentMethod null (and retrieve is NOT called);
 *   - Stripe disabled (null service) → paymentMethod null;
 *   - a retrieve failure is best-effort → paymentMethod null but the
 *     subscription still returns (the card error must NOT break the screen);
 *   - no subscription → {subscription:null, paymentMethod:null}.
 */
import { describe, expect, test } from "bun:test"
import type { Db } from "mongodb"
import { createGetSubscriptionHandler } from "../../src/handlers/domains/billing/get-subscription"
import { StripePaymentService } from "../../src/services/stripe-payment-service"
import { FakeStripe, InMemoryDb } from "./_stripe-test-helpers"

const ctx = (userId: string) => ({ userId }) as any
const D = (iso: string) => new Date(iso)

function seedGrowthPlan(db: InMemoryDb, over: Record<string, any> = {}) {
  db.seed("billing_plans", [
    {
      _id: "plan_growth", name: "growth", displayName: "Growth", description: "", price: 89,
      currency: "EUR", agentHoursLimit: 40,
      features: { terosModel: true, byok: true, maxWorkspaces: -1, prioritySupport: true },
      isPublic: true, contactSales: false,
      ...over,
    },
  ])
}

function seedSub(db: InMemoryDb) {
  db.seed("billing_subscriptions", [
    {
      _id: "sub1", userId: "u1", planId: "plan_growth", customAgentHoursLimit: null,
      customPrice: null, customPriceNote: null, agentHoursUsed: 12, overageHours: 0,
      currentPeriodStart: D("2026-06-01"), currentPeriodEnd: D("2026-07-01"),
      status: "active", startDate: D("2026-06-01"), endDate: null, cancelAtPeriodEnd: false,
      scheduledPlanChange: null, paymentMethod: "stripe", billingNotes: "", teamId: null,
      terosProviderConfigId: null, createdAt: D("2026-06-01"), updatedAt: D("2026-06-01"),
    },
  ])
}

function seedCustomer(db: InMemoryDb, defaultPaymentMethodId: string | null) {
  db.seed("billing_customers", [
    {
      _id: "u1", userId: "u1", stripeCustomerId: "cus_1", defaultPaymentMethodId,
      country: null, taxId: null, taxIdType: null, createdAt: D("2026-06-01"), updatedAt: D("2026-06-01"),
    },
  ])
}

function mkEnv(
  opts: {
    sub?: boolean
    customerPm?: string | null
    stripe?: boolean
    boostPrice?: number | null
    planOver?: Record<string, any>
  } = {},
) {
  const { sub = true, customerPm = "pm_1", stripe = true, boostPrice = null, planOver = {} } = opts
  const db = new InMemoryDb()
  seedGrowthPlan(db, planOver)
  if (sub) seedSub(db)
  if (customerPm !== undefined) seedCustomer(db, customerPm)
  const fake = new FakeStripe()
  const svc = stripe ? new StripePaymentService(db as unknown as Db, fake) : null
  const handler = createGetSubscriptionHandler(db as unknown as Db, svc, {
    boostHourPrice: boostPrice,
    boostCurrency: "EUR",
  })
  return { db, fake, svc, handler }
}

describe("billing.get-subscription — payment method", () => {
  test("returns the exact card details when one is vaulted", async () => {
    const { fake, handler } = mkEnv()
    fake.setCard({ brand: "visa", last4: "4242", expMonth: 4, expYear: 2027 })

    const res = await handler(ctx("u1"), {})
    expect(res.subscription?.planName).toBe("Growth")
    expect(res.paymentMethod).toEqual({ brand: "visa", last4: "4242", expMonth: 4, expYear: 2027 })
    expect(fake.calls.filter((c) => c.method === "retrievePaymentMethod").length).toBe(1)
  })

  test("no vaulted method → null, and retrieve is never called", async () => {
    const { fake, handler } = mkEnv({ customerPm: null })
    const res = await handler(ctx("u1"), {})
    expect(res.subscription?.planName).toBe("Growth")
    expect(res.paymentMethod).toBeNull()
    expect(fake.calls.filter((c) => c.method === "retrievePaymentMethod").length).toBe(0)
  })

  test("Stripe disabled (null service) → paymentMethod null", async () => {
    const { handler } = mkEnv({ stripe: false })
    const res = await handler(ctx("u1"), {})
    expect(res.subscription?.planName).toBe("Growth")
    expect(res.paymentMethod).toBeNull()
  })

  test("a retrieve failure is best-effort: subscription still returns, paymentMethod null", async () => {
    const { fake, handler } = mkEnv()
    fake.retrievePaymentMethod = async () => {
      throw new Error("stripe down")
    }
    const res = await handler(ctx("u1"), {})
    expect(res.subscription?.planName).toBe("Growth") // screen still works
    expect(res.paymentMethod).toBeNull()
  })

  test("no active subscription → both null", async () => {
    const { handler } = mkEnv({ sub: false })
    const res = await handler(ctx("u1"), {})
    expect(res.subscription).toBeNull()
    expect(res.paymentMethod).toBeNull()
  })
})

describe("billing.get-subscription — boostPricing (TER-596 I4)", () => {
  test("exposes the per-hour price when Stripe is on and a price is set", async () => {
    const { handler } = mkEnv({ boostPrice: 3 })
    const res = await handler(ctx("u1"), {})
    expect(res.boostPricing).toEqual({ hourPrice: 3, currency: "EUR" })
  })

  test("boostPricing is null when no price is configured (PURCHASE_DISABLED)", async () => {
    const { handler } = mkEnv({ boostPrice: null })
    const res = await handler(ctx("u1"), {})
    // MUST BITE: showing a buy form with no price would let users buy at €0.
    expect(res.boostPricing).toBeNull()
  })

  test("boostPricing is null when Stripe is off (PURCHASE_UNAVAILABLE), even with a price", async () => {
    const { handler } = mkEnv({ stripe: false, boostPrice: 3 })
    const res = await handler(ctx("u1"), {})
    // MUST BITE: no gateway → no purchase possible, regardless of the price.
    expect(res.boostPricing).toBeNull()
  })

  // The empty-subscription branch must still carry the pricing (the caller may
  // surface a buy option in the no-sub state).
  test("boostPricing is present even with no active subscription", async () => {
    const { handler } = mkEnv({ sub: false, boostPrice: 3 })
    const res = await handler(ctx("u1"), {})
    expect(res.subscription).toBeNull()
    expect(res.boostPricing).toEqual({ hourPrice: 3, currency: "EUR" })
  })

  test("boostPricing is null on a NON-METERED plan (PURCHASE_NOT_APPLICABLE), even with price+Stripe", async () => {
    const { handler } = mkEnv({
      boostPrice: 3,
      planOver: { features: { terosModel: false, byok: true, maxWorkspaces: -1, prioritySupport: true } },
    })
    const res = await handler(ctx("u1"), {})
    // MUST BITE: a BYOK / non-Teros plan can't use boost hours; advertising a
    // price the backend rejects with PURCHASE_NOT_APPLICABLE dead-ends the user.
    expect(res.boostPricing).toBeNull()
  })

  test("boostPricing is null on an UNMETERED (0-hour) plan, even with price+Stripe", async () => {
    const { handler } = mkEnv({
      boostPrice: 3,
      planOver: { agentHoursLimit: 0 }, // terosModel:true + 0h ⇒ unlimited, not metered
    })
    const res = await handler(ctx("u1"), {})
    // MUST BITE: dropping the `getEffectiveLimit > 0` clause would advertise a
    // boost on an unmetered plan, where extra hours mean nothing.
    expect(res.boostPricing).toBeNull()
  })
})
