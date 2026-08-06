/**
 * TER-596 I1 — billing.purchase-boost (self-serve boost purchase).
 *
 * The delicate one: real money + idempotency. These tests assert the EXACT
 * persisted/returned payloads and the anti-double-charge guarantees, with
 * faithful FakeStripe (idempotency-key replay) + InMemoryDb (real _id-unique
 * MongoServerError). Mutation-verified — each survivor hunt noted inline.
 */
import { describe, expect, test } from "bun:test"
import type { Db } from "mongodb"
import { createPurchaseBoostHandler } from "../../src/handlers/domains/billing/purchase-boost"
import { createIndexHealingConflict } from "../../src/models/billing"
import migration003 from "../../src/migrations/20260617_003_billing_access_requests_boosts"
import { StripePaymentService } from "../../src/services/stripe-payment-service"
import { FakeStripe, InMemoryDb, stripeError } from "./_stripe-test-helpers"

const ctx = (userId: string) => ({ userId }) as any
const D = (iso: string) => new Date(iso)
const CFG = { boostHourPrice: 2, boostCurrency: "EUR" }

function seedGrowthPlan(db: InMemoryDb, over: Record<string, any> = {}) {
  db.seed("billing_plans", [
    {
      _id: "plan_growth",
      name: "growth",
      displayName: "Growth",
      description: "g",
      price: 89,
      currency: "EUR",
      agentHoursLimit: 40,
      features: { terosModel: true, byok: true, maxWorkspaces: -1, prioritySupport: true },
      isPublic: true,
      ...over,
    },
  ])
}

function seedSub(db: InMemoryDb, over: Record<string, any> = {}) {
  db.seed("billing_subscriptions", [
    {
      _id: "sub1",
      userId: "u1",
      planId: "plan_growth",
      customAgentHoursLimit: null,
      customPrice: null,
      customPriceNote: null,
      agentHoursUsed: 38,
      overageHours: 0,
      // Wide period so getActiveBoostHours always counts the boost regardless of `now`.
      currentPeriodStart: D("2020-01-01"),
      currentPeriodEnd: D("2030-01-01"),
      status: "active",
      startDate: D("2020-01-01"),
      endDate: null,
      cancelAtPeriodEnd: false,
      scheduledPlanChange: null,
      paymentMethod: "stripe",
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

/** Full happy-path environment: plan + active sub + customer with a card. */
function mkEnv(
  over: {
    sub?: Record<string, any>
    customer?: Record<string, any>
    plan?: Record<string, any>
  } = {},
) {
  const db = new InMemoryDb()
  seedGrowthPlan(db, over.plan)
  seedSub(db, over.sub)
  seedCustomer(db, over.customer)
  const stripe = new FakeStripe()
  const svc = new StripePaymentService(db as unknown as Db, stripe)
  const handler = createPurchaseBoostHandler(db as unknown as Db, svc, CFG)
  return { db, stripe, svc, handler }
}

const payCalls = (s: FakeStripe) => s.calls.filter((c) => c.method === "payInvoice").length

describe("billing.purchase-boost — happy path", () => {
  test("charges, persists a paid invoice, grants the boost, returns exact data", async () => {
    const { db, stripe, handler } = mkEnv()
    const res = await handler(ctx("u1"), { hours: 10, reqId: "req-abc" })

    const purchaseId = "boost-purchase:u1:req-abc"
    // Response is DATA, not UI strings.
    expect(res.boostId).toBe(purchaseId)
    expect(res.hours).toBe(10)
    expect(res.amount).toBe(20) // 10h × €2
    expect(res.currency).toBe("EUR")
    expect(res.invoice).not.toBeNull()
    expect(res.invoice!.number).toMatch(/^TEROS-/)
    expect(res.invoice!.hostedInvoiceUrl).toMatch(/invoice\.stripe\.test/)
    expect(res.invoice!.invoicePdfUrl).toMatch(/\.pdf$/)
    // Effective limit reflects the purchase immediately.
    expect(res.subscription.boostHours).toBe(10)
    expect(res.subscription.agentHoursLimit).toBe(50) // 40 base + 10 boost

    // Boost persisted (PK = purchaseId; self-serve → accessRequestId null).
    const boost = await db.collection("billing_hour_boosts").findOne({ _id: purchaseId })
    expect(boost).toMatchObject({
      _id: purchaseId,
      userId: "u1",
      subscriptionId: "sub1",
      hours: 10,
      status: "active",
      grantedBy: "u1",
      accessRequestId: null,
    })
    expect(boost!.periodStart).toEqual(D("2020-01-01"))
    expect(boost!.periodEnd).toEqual(D("2030-01-01"))

    // Invoice persisted PAID (so the charge-cron, which scans pending/overdue,
    // never re-bills it).
    const inv = await db.collection("billing_invoices").findOne({ _id: purchaseId })
    expect(inv).toMatchObject({
      _id: purchaseId,
      userId: "u1",
      subscriptionId: "sub1",
      // kind:'boost' keeps this invoice out of the partial billing_inv_period_unique
      // index, so it never collides with the period invoice (TER-596 I1).
      kind: "boost",
      amount: 20,
      currency: "EUR",
      status: "paid",
      paymentMethod: "stripe",
      notes: "Boost purchase: 10h",
    })
    expect(inv!.externalReference).toMatch(/^in_/)

    // Charged via Stripe with purchaseId-derived idempotency keys.
    expect(stripe.calls.find((c) => c.method === "createInvoiceItem")?.idempotencyKey).toBe(
      `ii:${purchaseId}`,
    )
    expect(stripe.calls.find((c) => c.method === "payInvoice")?.idempotencyKey).toBe(
      `pay:${purchaseId}:1`,
    )
  })

  test("amount rounds to cents (fractional €/hour)", async () => {
    const db = new InMemoryDb()
    seedGrowthPlan(db)
    seedSub(db)
    seedCustomer(db)
    const stripe = new FakeStripe()
    const svc = new StripePaymentService(db as unknown as Db, stripe)
    const handler = createPurchaseBoostHandler(db as unknown as Db, svc, {
      boostHourPrice: 2.5,
      boostCurrency: "EUR",
    })
    const res = await handler(ctx("u1"), { hours: 3, reqId: "r1" })
    expect(res.amount).toBe(7.5) // 3 × 2.5
  })
})

describe("billing.purchase-boost — idempotency (anti double-charge)", () => {
  test("same reqId twice: one charge, one boost, one invoice (short-circuit)", async () => {
    const { db, stripe, handler } = mkEnv()
    const r1 = await handler(ctx("u1"), { hours: 5, reqId: "dup" })
    const r2 = await handler(ctx("u1"), { hours: 5, reqId: "dup" })

    // Identical result, charged exactly once.
    expect(r2.boostId).toBe(r1.boostId)
    expect(payCalls(stripe)).toBe(1) // second call never touched Stripe
    expect(await db.collection("billing_hour_boosts").countDocuments({})).toBe(1)
    expect(await db.collection("billing_invoices").countDocuments({})).toBe(1)
    // Survivor hunt: minting the boost with `_id: crypto.randomUUID()` instead of
    // the purchaseId makes the short-circuit miss → 2 boosts + 2 charges → red.
  })

  test("crash between charge and grant self-heals on retry (no double charge)", async () => {
    const { db, stripe, handler } = mkEnv()
    const boosts = db.collection("billing_hour_boosts")
    const realInsert = boosts.insertOne.bind(boosts)
    let chargeRuns = 0
    stripe.chargeBehavior = () => {
      chargeRuns++
    }

    // First attempt: blow up AFTER the charge + invoice, while inserting the boost.
    let boom = true
    ;(boosts as any).insertOne = async (doc: any) => {
      if (boom) {
        boom = false
        throw new Error("simulated crash before grant")
      }
      return realInsert(doc)
    }
    await expect(handler(ctx("u1"), { hours: 7, reqId: "crash" })).rejects.toThrow(
      /simulated crash/,
    )

    // Charge happened, invoice persisted, but NO boost yet.
    expect(chargeRuns).toBe(1)
    expect(await db.collection("billing_invoices").countDocuments({})).toBe(1)
    expect(await boosts.countDocuments({})).toBe(0)

    // Retry with the SAME reqId completes: Stripe replays the paid invoice (no
    // re-charge), the boost is finally granted.
    const res = await handler(ctx("u1"), { hours: 7, reqId: "crash" })
    expect(chargeRuns).toBe(1) // still one real charge — Stripe idempotency held
    expect(res.boostId).toBe("boost-purchase:u1:crash")
    expect(await boosts.countDocuments({})).toBe(1)
    expect(await db.collection("billing_invoices").countDocuments({})).toBe(1)
  })

  test("retry after Stripe idempotency expiry (>24h) reuses the invoice, never re-creates it", async () => {
    const { db, stripe, handler } = mkEnv()
    const boosts = db.collection("billing_hour_boosts")
    const realInsert = boosts.insertOne.bind(boosts)
    let boom = true
    ;(boosts as any).insertOne = async (doc: any) => {
      if (boom) {
        boom = false
        throw new Error("simulated crash before grant")
      }
      return realInsert(doc)
    }

    // First attempt: charge + invoice (with a Stripe invoice id) persisted, then
    // crash before the boost insert.
    await expect(handler(ctx("u1"), { hours: 7, reqId: "exp" })).rejects.toThrow(/simulated crash/)
    const createInvoiceCalls = () => stripe.calls.filter((c) => c.method === "createInvoice").length
    expect(createInvoiceCalls()).toBe(1)
    const persisted = await db.collection("billing_invoices").findOne({ _id: "boost-purchase:u1:exp" })
    expect(persisted!.externalReference).toMatch(/^in_/)

    // Simulate >24h passing: Stripe drops the idempotency keys, so a replay would
    // re-run create/pay instead of returning the cached invoice.
    stripe.clearIdempotency()

    // Retry with the SAME reqId. The handler rereads the persisted Stripe invoice
    // id and passes it back, so chargeInvoice REUSES that invoice.
    const res = await handler(ctx("u1"), { hours: 7, reqId: "exp" })
    expect(res.boostId).toBe("boost-purchase:u1:exp")
    expect(await boosts.countDocuments({})).toBe(1)
    expect(await db.collection("billing_invoices").countDocuments({})).toBe(1)
    // MUST BITE: drop the `persisted?.externalReference` reread (externalReference:
    // null) and the expired keys let chargeInvoice mint a SECOND Stripe invoice
    // → createInvoice runs twice → double charge.
    expect(createInvoiceCalls()).toBe(1)
  })
})

describe("billing.purchase-boost — refusals charge nothing", () => {
  test("PURCHASE_UNAVAILABLE when Stripe is not configured", async () => {
    const db = new InMemoryDb()
    seedGrowthPlan(db)
    seedSub(db)
    seedCustomer(db)
    const svc = new StripePaymentService(db as unknown as Db, null) // disabled
    const handler = createPurchaseBoostHandler(db as unknown as Db, svc, CFG)
    await expect(handler(ctx("u1"), { hours: 5, reqId: "r1" })).rejects.toThrow(/not available/i)
  })

  test("PURCHASE_DISABLED when no price is configured, without touching Stripe", async () => {
    const { stripe, db, svc } = mkEnv()
    const handler = createPurchaseBoostHandler(db as unknown as Db, svc, {
      boostHourPrice: null,
      boostCurrency: "EUR",
    })
    await expect(handler(ctx("u1"), { hours: 5, reqId: "r1" })).rejects.toThrow(/not enabled/i)
    expect(stripe.calls.length).toBe(0)
    expect(await db.collection("billing_hour_boosts").countDocuments({})).toBe(0)
  })

  test("NO_PAYMENT_METHOD when the customer has no card, without charging", async () => {
    const { db, stripe, handler } = mkEnv({ customer: { defaultPaymentMethodId: null } })
    await expect(handler(ctx("u1"), { hours: 5, reqId: "r1" })).rejects.toThrow(/payment method/i)
    expect(payCalls(stripe)).toBe(0)
    expect(await db.collection("billing_hour_boosts").countDocuments({})).toBe(0)
    expect(await db.collection("billing_invoices").countDocuments({})).toBe(0)
  })

  test("NO_SUBSCRIPTION when the user has no active sub", async () => {
    const db = new InMemoryDb()
    seedGrowthPlan(db)
    seedCustomer(db) // no sub
    const stripe = new FakeStripe()
    const svc = new StripePaymentService(db as unknown as Db, stripe)
    const handler = createPurchaseBoostHandler(db as unknown as Db, svc, CFG)
    await expect(handler(ctx("u1"), { hours: 5, reqId: "r1" })).rejects.toThrow(
      /no active subscription/i,
    )
    expect(stripe.calls.length).toBe(0)
  })

  test("PURCHASE_NOT_APPLICABLE on a non-metered plan (boost would add nothing)", async () => {
    const { db, stripe, handler } = mkEnv({
      plan: {
        features: { terosModel: false, byok: true, maxWorkspaces: -1, prioritySupport: false },
      },
    })
    await expect(handler(ctx("u1"), { hours: 5, reqId: "r1" })).rejects.toThrow(/does not meter/i)
    expect(stripe.calls.length).toBe(0)
    expect(await db.collection("billing_hour_boosts").countDocuments({})).toBe(0)
  })

  test("payment decline → PAYMENT_FAILED code, no boost, no invoice", async () => {
    const { db, stripe, handler } = mkEnv()
    stripe.chargeBehavior = () => {
      throw stripeError({
        type: "StripeCardError",
        decline_code: "generic_decline",
        code: "card_declined",
        message: "Your card was declined.",
      })
    }
    const err = await handler(ctx("u1"), { hours: 5, reqId: "r1" }).catch((e) => e)
    expect(err.code).toBe("CARD_DECLINED")
    expect(err.message).toMatch(/declined/i)
    // charge-before-grant: a failed charge grants nothing.
    expect(await db.collection("billing_hour_boosts").countDocuments({})).toBe(0)
    expect(await db.collection("billing_invoices").countDocuments({})).toBe(0)
  })
})

describe("billing.purchase-boost — input validation", () => {
  test.each([
    ["zero", 0],
    ["negative", -3],
    ["fractional", 2.5],
    ["too many", 10001],
    ["not a number", "lots" as any],
  ])("rejects hours=%s", async (_label, hours) => {
    const { stripe, handler } = mkEnv()
    await expect(handler(ctx("u1"), { hours, reqId: "r1" })).rejects.toThrow(
      /hours must be an integer/i,
    )
    expect(stripe.calls.length).toBe(0)
  })

  test.each([
    ["empty", ""],
    ["whitespace", "  "],
    ["colon (would break the _id)", "a:b"],
    ["missing", undefined as any],
  ])("rejects reqId=%s", async (_label, reqId) => {
    const { stripe, handler } = mkEnv()
    await expect(handler(ctx("u1"), { hours: 5, reqId })).rejects.toThrow(/reqId/i)
    expect(stripe.calls.length).toBe(0)
  })
})

describe("createIndexHealingConflict — boost request index spec change", () => {
  // The InMemoryDb does not model secondary unique indexes, so this is what
  // guards the cross-cutting invariant: making accessRequestId nullable (purchase
  // boosts) REQUIRES the unique index to become partial, and ensureBillingIndexes
  // runs BEFORE migrations — so the boot-time createIndex must heal a DB that
  // still has the old non-partial index instead of crashing on it (code 85/86).
  const PARTIAL = { accessRequestId: { $type: "string" } }

  function fakeCol(opts: { conflictCode?: number } = {}) {
    const created: Array<{ keys: any; options: any }> = []
    const dropped: string[] = []
    let first = true
    return {
      created,
      dropped,
      async createIndex(keys: any, options: any) {
        if (opts.conflictCode && first) {
          first = false
          const e: any = new Error(`index conflict ${opts.conflictCode}`)
          e.code = opts.conflictCode
          throw e
        }
        created.push({ keys, options })
      },
      async dropIndex(name: string) {
        dropped.push(name)
      },
    }
  }

  const args = {
    keys: { accessRequestId: 1 } as Record<string, 1 | -1>,
    opts: { name: "billing_boost_request_unique", unique: true, partialFilterExpression: PARTIAL },
  }

  test("fresh DB / same spec: plain createIndex, no drop", async () => {
    const col = fakeCol()
    await createIndexHealingConflict(col as any, args.keys, args.opts)
    expect(col.dropped).toEqual([])
    expect(col.created).toHaveLength(1)
    expect(col.created[0].options.partialFilterExpression).toEqual(PARTIAL)
  })

  test("key-spec conflict (code 86): drops the old index, recreates it partial", async () => {
    const col = fakeCol({ conflictCode: 86 })
    await createIndexHealingConflict(col as any, args.keys, args.opts)
    expect(col.dropped).toEqual(["billing_boost_request_unique"])
    expect(col.created).toHaveLength(1) // the recreate after the drop
    expect(col.created[0].options.partialFilterExpression).toEqual(PARTIAL)
    // Survivor hunt: skip the drop → the recreate hits the same conflict → throws → red.
  })

  test("options conflict (code 85): drops the old index, recreates it partial", async () => {
    // Adding a partialFilterExpression to an existing SAME-KEY index yields
    // IndexOptionsConflict (85), NOT 86. The boot-time heal MUST catch it too,
    // else the partial-index changes (TER-596 I1: this boost index + the invoice
    // period index) crash startup on any DB that still has the old non-partial one.
    const col = fakeCol({ conflictCode: 85 })
    await createIndexHealingConflict(col as any, args.keys, args.opts)
    expect(col.dropped).toEqual(["billing_boost_request_unique"])
    expect(col.created).toHaveLength(1)
    expect(col.created[0].options.partialFilterExpression).toEqual(PARTIAL)
    // MUST BITE: reverting the helper to `code !== 86` rethrows 85 → red.
  })

  test("a non-conflict error propagates and never drops", async () => {
    const col: any = {
      dropped: [] as string[],
      async createIndex() {
        const e: any = new Error("boom")
        e.code = 11000
        throw e
      },
      async dropIndex(n: string) {
        col.dropped.push(n)
      },
    }
    await expect(createIndexHealingConflict(col, args.keys, { name: "x" })).rejects.toThrow(/boom/)
    expect(col.dropped).toEqual([]) // must not drop on an unrelated error
  })
})

describe("migration 20260617_003 — boost index aligned with ensureBillingIndexes", () => {
  test("creates billing_boost_request_unique as PARTIAL (no fresh-DB boot conflict)", async () => {
    // On a fresh DB, ensureBillingIndexes creates this index PARTIAL at boot,
    // then this migration runs. A non-partial spec here would collide
    // (IndexOptionsConflict 85) with the boot index and abort startup. So the
    // migration's spec MUST match the partial boot spec (TER-596 I1).
    const created: Array<{ keys: any; options: any }> = []
    const fakeDb: any = {
      collection() {
        return {
          async createIndex(keys: any, options: any) {
            created.push({ keys, options })
          },
        }
      },
    }
    await migration003.up(fakeDb)
    const boostIdx = created.find((c) => c.options?.name === "billing_boost_request_unique")
    expect(boostIdx).toBeDefined()
    // MUST BITE: reverting the migration to a non-partial spec drops the
    // partialFilterExpression → fresh-DB boot crash.
    expect(boostIdx!.options.partialFilterExpression).toEqual({
      accessRequestId: { $type: "string" },
    })
  })
})
