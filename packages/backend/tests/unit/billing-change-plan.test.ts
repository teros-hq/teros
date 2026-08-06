/**
 * TER-619 — billing.change-plan charge-BEFORE-grant gate.
 *
 * Reproduces and locks the production monetization hole: a self-serve upgrade to
 * a paid tier was granted WITHOUT charging — no card → free forever; with a card
 * → a deferred customer-balance transaction that never charged immediately
 * (Pablo's case). The fix charges the prorated difference to the vaulted card
 * IMMEDIATELY via Stripe Invoices and grants only on success.
 *
 * Faithful FakeStripe (real invoice lifecycle + idempotency) + InMemoryDb. Each
 * assertion that pins the fix notes its survivor hunt inline.
 */
import { describe, expect, test } from "bun:test"
import type { Db } from "mongodb"
import { createChangePlanHandler } from "../../src/handlers/domains/billing/change-plan"
import { getActiveSubscription } from "../../src/models/billing"
import { StripePaymentService } from "../../src/services/stripe-payment-service"
import { FakeStripe, InMemoryDb, stripeError } from "./_stripe-test-helpers"

const ctx = (userId: string) => ({ userId }) as any
const D = (iso: string) => new Date(iso)

const FEAT = { terosModel: true, byok: true, maxWorkspaces: -1, prioritySupport: true } as const

function seedPlans(db: InMemoryDb) {
  db.seed("billing_plans", [
    { _id: "plan_starter", name: "starter", displayName: "Starter", description: "s", price: 0, currency: "EUR", agentHoursLimit: 10, features: { ...FEAT, prioritySupport: false }, isPublic: true },
    { _id: "plan_growth", name: "growth", displayName: "Growth", description: "g", price: 89, currency: "EUR", agentHoursLimit: 40, features: FEAT, isPublic: true, popular: true },
    { _id: "plan_pro", name: "pro", displayName: "Pro", description: "p", price: 179, currency: "EUR", agentHoursLimit: 80, features: FEAT, isPublic: true },
    // A second €89 plan so a same-price change exercises the lateral (charge===0) path.
    { _id: "plan_lateral", name: "lateral", displayName: "Lateral", description: "l", price: 89, currency: "EUR", agentHoursLimit: 40, features: FEAT, isPublic: true },
  ])
}

function seedSub(db: InMemoryDb, over: Record<string, any> = {}) {
  db.seed("billing_subscriptions", [
    {
      _id: "sub1",
      userId: "u1",
      planId: "plan_starter",
      customAgentHoursLimit: null,
      customPrice: null,
      customPriceNote: null,
      agentHoursUsed: 0,
      overageHours: 0,
      lastBilledHourBucket: D("2020-01-01"),
      // Wide period so the upgrade proration is deterministically > 0 (remaining
      // fraction is always positive while `now` < 2030).
      currentPeriodStart: D("2020-01-01"),
      currentPeriodEnd: D("2030-01-01"),
      status: "active",
      startDate: D("2020-01-01"),
      endDate: null,
      cancelAtPeriodEnd: false,
      scheduledPlanChange: null,
      paymentMethod: "manual",
      billingNotes: "",
      teamId: null,
      terosProviderConfigId: null,
      createdAt: D("2020-01-01"),
      updatedAt: D("2020-01-01"),
      ...over,
    },
  ])
}

function seedCustomer(db: InMemoryDb, over: Record<string, any> = {}) {
  db.seed("billing_customers", [
    {
      _id: "u1",
      userId: "u1",
      stripeCustomerId: "cus_1",
      defaultPaymentMethodId: "pm_1",
      country: null,
      taxId: null,
      taxIdType: null,
      createdAt: D("2020-01-01"),
      updatedAt: D("2020-01-01"),
      ...over,
    },
  ])
}

function mkEnv(
  over: { sub?: Record<string, any>; customer?: Record<string, any> | null; stripeDisabled?: boolean } = {},
) {
  const db = new InMemoryDb()
  seedPlans(db)
  seedSub(db, over.sub)
  if (over.customer !== null) seedCustomer(db, over.customer)
  const stripe = new FakeStripe()
  const svc = new StripePaymentService(db as unknown as Db, over.stripeDisabled ? null : stripe)
  const handler = createChangePlanHandler(db as unknown as Db, svc)
  return { db, stripe, svc, handler }
}

const payCalls = (s: FakeStripe) => s.calls.filter((c) => c.method === "payInvoice").length
const balanceTxnCalls = (s: FakeStripe) =>
  s.calls.filter((c) => c.method === "createCustomerBalanceTransaction").length
const activePlanId = async (db: InMemoryDb) =>
  (await getActiveSubscription(db as unknown as Db, "u1"))?.planId ?? null
const invoiceCount = (db: InMemoryDb) => db.collection("billing_invoices").countDocuments({})

describe("billing.change-plan — paid upgrade gate (TER-619)", () => {
  test("REGRESSION: free→Growth with NO card is refused, stays on Starter, charges nothing", async () => {
    const { db, stripe, handler } = mkEnv({ customer: { defaultPaymentMethodId: null } })

    const err = await handler(ctx("u1"), { planId: "plan_growth", reqId: "r1" }).catch((e) => e)

    expect(err.code).toBe("NO_PAYMENT_METHOD")
    // The plan was NOT granted — this is the bug: the old code created the Growth
    // sub before (and regardless of) the charge.
    expect(await activePlanId(db)).toBe("plan_starter")
    expect((await db.collection("billing_subscriptions").find({}).toArray()).length).toBe(1)
    expect(payCalls(stripe)).toBe(0)
    expect(await invoiceCount(db)).toBe(0)
    // Survivor hunt: drop the gate (grant before the charge result) → a Growth sub
    // appears + active plan flips to plan_growth → red.
  })

  test("PABLO'S CASE: with a card, the prorated difference is charged IMMEDIATELY (invoice), not deferred as a balance transaction", async () => {
    const { db, stripe, handler } = mkEnv()

    const res = await handler(ctx("u1"), { planId: "plan_growth", reqId: "pay1" })

    expect(res.kind).toBe("upgraded")
    expect(await activePlanId(db)).toBe("plan_growth")
    // Immediate card charge via Stripe Invoices…
    expect(payCalls(stripe)).toBe(1)
    // …and NOT the old deferred customer-balance transaction (Pablo saw no charge
    // precisely because the old path used this instead of an immediate invoice).
    expect(balanceTxnCalls(stripe)).toBe(0)

    const inv = await db.collection("billing_invoices").findOne({ _id: "plan-change:u1:plan_growth:pay1" })
    expect(inv).toMatchObject({
      _id: "plan-change:u1:plan_growth:pay1",
      userId: "u1",
      kind: "proration",
      status: "paid",
      paymentMethod: "stripe",
      currency: "EUR",
    })
    expect(inv!.amount).toBeGreaterThan(0)
    expect(inv!.externalReference).toMatch(/^in_/)
    expect(res.invoice).not.toBeNull()
    expect(res.invoice!.amount).toBe(inv!.amount)
    // Survivor hunt: revert change-plan to applyPlanChange(..., { stripe }) and the
    // charge becomes a createCustomerBalanceTransaction (balanceTxnCalls=1, payCalls=0) → red.
  })

  test("with a card but DECLINED → refused, stays on Starter, no invoice persisted", async () => {
    const { db, stripe, handler } = mkEnv()
    stripe.chargeBehavior = () => {
      throw stripeError({
        type: "StripeCardError",
        code: "card_declined",
        decline_code: "generic_decline",
        message: "Your card was declined.",
      })
    }

    const err = await handler(ctx("u1"), { planId: "plan_growth", reqId: "r1" }).catch((e) => e)

    expect(err.code).toBe("CARD_DECLINED")
    expect(await activePlanId(db)).toBe("plan_starter")
    expect(await invoiceCount(db)).toBe(0) // charge-before-grant: a failed charge persists nothing
  })

  test("Growth→Pro with NO card is refused, stays on Growth", async () => {
    const { db, stripe, handler } = mkEnv({
      sub: { planId: "plan_growth" },
      customer: { defaultPaymentMethodId: null },
    })

    const err = await handler(ctx("u1"), { planId: "plan_pro", reqId: "r1" }).catch((e) => e)

    expect(err.code).toBe("NO_PAYMENT_METHOD")
    expect(await activePlanId(db)).toBe("plan_growth")
    expect(payCalls(stripe)).toBe(0)
  })

  test("reqId is required for a paid upgrade (it moves money) — refused without it, no charge", async () => {
    const { db, stripe, handler } = mkEnv()

    const err = await handler(ctx("u1"), { planId: "plan_growth" }).catch((e) => e)
    expect(err.code).toBe("INVALID_INPUT")
    expect(err.message).toMatch(/reqId/i)
    expect(payCalls(stripe)).toBe(0)
    expect(await activePlanId(db)).toBe("plan_starter")

    // A malformed token (would break the derived invoice _id) is rejected too.
    const err2 = await handler(ctx("u1"), { planId: "plan_growth", reqId: "a:b" }).catch((e) => e)
    expect(err2.code).toBe("INVALID_INPUT")
    expect(payCalls(stripe)).toBe(0)
  })

  test("idempotency: a completed upgrade + a replay of the same plan is SAME_PLAN, never a second charge", async () => {
    const { db, stripe, handler } = mkEnv()

    await handler(ctx("u1"), { planId: "plan_growth", reqId: "once" })
    expect(payCalls(stripe)).toBe(1)

    const err = await handler(ctx("u1"), { planId: "plan_growth", reqId: "twice" }).catch((e) => e)
    expect(err.code).toBe("SAME_PLAN")
    expect(payCalls(stripe)).toBe(1) // the replay never re-charged
  })

  test("the idempotency token is bound to the TARGET plan: replaying a reqId for a different, pricier plan charges for real (no cross-plan free upgrade)", async () => {
    const { db, stripe, handler } = mkEnv()

    // Pay for Starter→Growth with reqId "R".
    await handler(ctx("u1"), { planId: "plan_growth", reqId: "R" })
    expect(payCalls(stripe)).toBe(1)
    expect(await activePlanId(db)).toBe("plan_growth")

    // Replay the SAME reqId for a pricier plan (Growth→Pro). It MUST charge again,
    // not reuse the cached Growth invoice's already-paid payment.
    await handler(ctx("u1"), { planId: "plan_pro", reqId: "R" })
    expect(await activePlanId(db)).toBe("plan_pro")
    expect(payCalls(stripe)).toBe(2) // a SECOND real charge

    const ids = (await db.collection("billing_invoices").find({}).toArray())
      .map((i) => i._id)
      .sort()
    expect(ids).toEqual(["plan-change:u1:plan_growth:R", "plan-change:u1:plan_pro:R"])
    // MUST BITE: drop planId from the invoiceId (`plan-change:<user>:<reqId>`) → the
    // second call reuses the Growth invoice, payInvoice returns the cached paid
    // result (payCalls stays 1), and Pro is granted for the Growth proration price.
  })
})

describe("billing.change-plan — non-charging paths are untouched", () => {
  test("downgrade (Growth→Starter) is deferred: no charge, stays on Growth with a scheduled change", async () => {
    const { db, stripe, handler } = mkEnv({ sub: { planId: "plan_growth" } })

    const res = await handler(ctx("u1"), { planId: "plan_starter" }) // no reqId needed

    expect(res.kind).toBe("downgrade_scheduled")
    expect(payCalls(stripe)).toBe(0)
    expect(balanceTxnCalls(stripe)).toBe(0)
    const sub = await db.collection("billing_subscriptions").findOne({ _id: "sub1" })
    expect(sub!.planId).toBe("plan_growth") // keeps the paid tier until the cut
    expect(sub!.scheduledPlanChange).toMatchObject({ planId: "plan_starter" })
  })

  test("lateral change (same €89 price) is applied immediately for free, no reqId, no charge", async () => {
    const { db, stripe, handler } = mkEnv({ sub: { planId: "plan_lateral" } })

    const res = await handler(ctx("u1"), { planId: "plan_growth" }) // no reqId

    expect(res.kind).toBe("upgraded")
    expect(await activePlanId(db)).toBe("plan_growth")
    expect(payCalls(stripe)).toBe(0) // proration diff is 0 → no gate, no charge
    expect(await invoiceCount(db)).toBe(0)
  })

  test("Stripe disabled (manual-billing server): upgrade applies for free, gate cannot enforce", async () => {
    const { db, stripe, handler } = mkEnv({ stripeDisabled: true })

    const res = await handler(ctx("u1"), { planId: "plan_growth" }) // no reqId, no Stripe

    expect(res.kind).toBe("upgraded")
    expect(await activePlanId(db)).toBe("plan_growth")
    expect(payCalls(stripe)).toBe(0)
  })
})
