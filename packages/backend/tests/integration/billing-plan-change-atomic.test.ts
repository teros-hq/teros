/**
 * Integration test: an immediate plan change never orphans the user (BIL-4).
 *
 * changeUserPlanImmediate closes the active subscription and then inserts the
 * new one. If the insert fails, the user must keep their original active
 * subscription: on a replica set the transaction rolls the close back; on a
 * standalone mongod the TER-625 compensation reopens it. Run it against both.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import { supportsTransactions } from "../../src/lib/mongo-transaction"
import { type BillingSubscription, ensureBillingIndexes } from "../../src/models/billing"
import { changeUserPlanImmediate } from "../../src/services/billing-subscription-ops"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_planchange_${Date.now()}`

let client: MongoClient
let db: Db
let available = false

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
    await ensureBillingIndexes(db)
  } catch {
    console.warn("[plan change atomic test] Mongo unreachable — skipping")
  }
})

afterAll(async () => {
  if (available) {
    await db.dropDatabase()
    await client.close()
  }
})

beforeEach(async () => {
  if (available) await db.collection("billing_subscriptions").deleteMany({})
})

function sub(over: Partial<BillingSubscription> = {}): BillingSubscription {
  const now = new Date()
  return {
    _id: "sub_1",
    userId: "user_1",
    planId: "plan_seed",
    customAgentHoursLimit: null,
    customPrice: null,
    customPriceNote: null,
    agentHoursUsed: 3,
    overageHours: 0,
    lastBilledHourBucket: now,
    currentPeriodStart: now,
    currentPeriodEnd: new Date(now.getTime() + 20 * 24 * 3_600_000),
    status: "active",
    startDate: now,
    endDate: null,
    paymentMethod: "manual",
    billingNotes: "",
    terosProviderConfigId: null,
    teamId: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  } as BillingSubscription
}

describe("changeUserPlanImmediate", () => {
  it("closes the old subscription and opens the new one", async () => {
    if (!available) return
    const active = sub()
    await db.collection("billing_subscriptions").insertOne(active as never)

    const newId = await changeUserPlanImmediate(db, active, "plan_pro", new Date())

    const subs = await db.collection("billing_subscriptions").find({}).toArray()
    expect(subs.find((s) => s._id === "sub_1")?.status).toBe("ended")
    expect(subs.find((s) => s._id === newId)?.status).toBe("active")
  })

  it(`a failed insert leaves the original subscription active (${"tx or compensation"})`, async () => {
    if (!available) return
    const active = sub()
    await db.collection("billing_subscriptions").insertOne(active as never)
    // Make the insert fail: a validator that rejects the new plan
    await db.command({
      collMod: "billing_subscriptions",
      validator: { planId: { $ne: "plan_rejected" } },
      validationLevel: "strict",
    })

    try {
      await expect(
        changeUserPlanImmediate(db, active, "plan_rejected", new Date()),
      ).rejects.toThrow()
    } finally {
      await db.command({ collMod: "billing_subscriptions", validator: {}, validationLevel: "off" })
    }

    const subs = await db.collection("billing_subscriptions").find({}).toArray()
    expect(subs).toHaveLength(1)
    expect(subs[0]?.status).toBe("active")
    console.log(`[plan change atomic test] ran with transactions=${await supportsTransactions(db)}`)
  })
})
