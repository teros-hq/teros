/**
 * Integration test: data-layer schema validation (GOV-2, src/db/validated.ts)
 * against a real mongod.
 *
 * With DB_SCHEMA_WRITES=error, the REAL creation paths (the same ones
 * jsonschema-validators.test.ts drives against mongod's own validator) must
 * succeed through a validated Db — that is what proves the zod schemas match
 * what the code writes. Invalid writes throw before reaching mongod, legacy
 * invalid documents are read with a warning and returned as they are, and
 * cursors, projections and transactions keep working through the proxies.
 *
 * Uses MONGODB_URI with a unique db name that is dropped afterwards. Skips
 * silently if Mongo is down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import { UserService } from "../../src/auth/user-service"
import {
  getSchemaWriteMode,
  SchemaValidationError,
  setSchemaLogger,
  setSchemaWriteMode,
  withSchemaValidation,
} from "../../src/db/validated"
import { withTransaction } from "../../src/lib/mongo-transaction"
import {
  type BillingSubscription,
  ensureBillingIndexes,
  getActiveSubscription,
  seedBillingPlans,
} from "../../src/models/billing"
import { chargeOneOffInvoice } from "../../src/services/billing-one-off-charge"
import { BillingResetCron } from "../../src/services/billing-reset-cron"
import { changeUserPlanImmediate } from "../../src/services/billing-subscription-ops"
import type { StripePaymentService } from "../../src/services/stripe-payment-service"
import type { VolumeService } from "../../src/services/volume-service"
import { WorkspaceService } from "../../src/services/workspace-service"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_schema_validation_${Date.now()}`

let client: MongoClient
let rawDb: Db
let db: Db
let available = false
const initialMode = getSchemaWriteMode()

type Warn = { obj: Record<string, any>; msg: string }
let warnings: Warn[] = []

const stubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => stubLogger,
}

let volumeSeq = 0
const fakeVolumes = {
  createWorkspace: async () => ({ volumeId: `vol_work_sv${++volumeSeq}` }),
  deleteWorkspace: async () => {},
} as unknown as VolumeService

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    rawDb = client.db(DB_NAME)
    await rawDb.dropDatabase()
    db = withSchemaValidation(rawDb)
    setSchemaWriteMode("error")
    await ensureBillingIndexes(db)
    available = true
  } catch {
    console.warn("[schema validation test] Mongo unreachable — skipping")
  }
})

beforeEach(() => {
  warnings = []
  setSchemaLogger({
    warn: (obj: object, msg: string) => warnings.push({ obj: obj as Record<string, any>, msg }),
    debug: () => {},
  })
})

afterAll(async () => {
  setSchemaLogger(null)
  setSchemaWriteMode(initialMode)
  if (available) {
    await rawDb.dropDatabase()
    await client.close()
  }
})

describe("real creation paths through a validated Db (DB_SCHEMA_WRITES=error)", () => {
  it("seeded billing plans validate", async () => {
    if (!available) return
    await seedBillingPlans(db)
    expect(await db.collection("billing_plans").countDocuments()).toBeGreaterThan(0)
    expect(warnings).toHaveLength(0)
  })

  it("a user, its private workspace and its default subscription validate", async () => {
    if (!available) return
    const workspaces = new WorkspaceService(db, fakeVolumes)
    const users = new UserService(db)
    users.setWorkspaceService(workspaces)

    const user = await users.createUser({
      email: "Schema@Example.com",
      displayName: "Schema Test",
      emailVerified: true,
    })
    // createUser swallows workspace/subscription failures: check they exist
    expect(await db.collection("users").countDocuments({ userId: user.userId })).toBe(1)
    expect(await db.collection("workspaces").countDocuments({ ownerId: user.userId, type: "private" })).toBe(1)
    expect(await getActiveSubscription(db, user.userId)).not.toBeNull()

    const oauth = await users.createUser({
      email: "oauth@example.com",
      displayName: undefined as unknown as string,
      avatarUrl: undefined,
    })
    expect(await db.collection("users").countDocuments({ userId: oauth.userId })).toBe(1)
    expect(warnings).toHaveLength(0)
  })

  it("a shared workspace validates", async () => {
    if (!available) return
    const ws = await new WorkspaceService(db, fakeVolumes).createWorkspace("user_owner", { name: "Shared" })
    expect(await db.collection("workspaces").countDocuments({ workspaceId: ws.workspaceId })).toBe(1)
  })

  it("a plan change, a cancellation renewal and a one-off invoice validate", async () => {
    if (!available) return
    const users = new UserService(db)
    const user = await users.createUser({ email: "billing@example.com", displayName: "Billing" })
    const active = (await getActiveSubscription(db, user.userId)) as BillingSubscription

    const newSubId = await changeUserPlanImmediate(db, active, "plan_pro", new Date())
    expect(await db.collection("billing_subscriptions").countDocuments({ _id: newSubId } as never)).toBe(1)

    const past = new Date(Date.now() - 2 * 86_400_000)
    await db
      .collection("billing_subscriptions")
      .updateOne({ _id: newSubId } as never, { $set: { currentPeriodEnd: past, cancelAtPeriodEnd: true } })
    await new BillingResetCron(db, stubLogger as never, null).runOnce()
    expect(
      await db.collection("billing_invoices").countDocuments({ subscriptionId: newSubId, kind: "subscription" }),
    ).toBe(1)
    const starter = await getActiveSubscription(db, user.userId)
    expect(starter?._id).not.toBe(newSubId)

    const stripe = {
      getCustomer: async () => ({ defaultPaymentMethodId: "pm_test" }),
      chargeInvoice: async () => ({
        status: "paid",
        stripeInvoiceId: "in_test",
        invoiceNumber: "TEROS-0001",
        hostedInvoiceUrl: null,
        invoicePdfUrl: null,
        amountPaid: 5,
      }),
    } as unknown as StripePaymentService
    const result = await chargeOneOffInvoice(db, stripe, {
      userId: user.userId,
      invoiceId: `boost-purchase:${user.userId}:1`,
      subscriptionId: starter!._id,
      amount: 5,
      currency: "EUR",
      description: "Boost",
      kind: "boost",
      periodStart: starter!.currentPeriodStart,
      periodEnd: starter!.currentPeriodEnd,
      notes: "test",
    })
    expect(result.status).toBe("paid")
    expect(warnings).toHaveLength(0)
  })
})

describe("invalid data", () => {
  it("an invalid insert throws and nothing is written", async () => {
    if (!available) return
    await expect(
      db.collection("users").insertOne({ userId: "user_noemail", profile: {}, status: "active", role: "user" }),
    ).rejects.toThrow(SchemaValidationError)
    expect(await rawDb.collection("users").countDocuments({ userId: "user_noemail" })).toBe(0)
  })

  it("an invalid upsert throws and nothing is written", async () => {
    if (!available) return
    await expect(
      db.collection("billing_invoices").updateOne({ subscriptionId: "sub_ghost" }, { $set: { amount: 1 } }, { upsert: true }),
    ).rejects.toThrow(SchemaValidationError)
    expect(await rawDb.collection("billing_invoices").countDocuments({ subscriptionId: "sub_ghost" })).toBe(0)
  })

  it("a legacy invalid document is read with a warning and returned as it is", async () => {
    if (!available) return
    await rawDb.collection("users").insertOne({ userId: "user_legacy", status: "deleted" })

    const doc = await db.collection("users").findOne({ userId: "user_legacy" })
    expect(doc?.status).toBe("deleted")
    expect(warnings).toHaveLength(1)
    expect(warnings[0].obj.collection).toBe("users")
    expect(warnings[0].obj.issues.map((i: { path: string }) => i.path).sort()).toEqual(["profile", "role", "status"])

    // Through a cursor (sort/limit/project chained after find), deduped
    const docs = await db.collection("users").find({ userId: "user_legacy" }).sort({ userId: 1 }).limit(5).toArray()
    expect(docs).toHaveLength(1)
    expect(warnings).toHaveLength(1)

    // Async iteration works and projected reads only check present fields
    const seen: unknown[] = []
    for await (const d of db.collection("users").find({ userId: "user_legacy" }).project({ userId: 1 })) seen.push(d)
    expect(seen).toEqual([{ _id: expect.anything(), userId: "user_legacy" }])
    expect(warnings).toHaveLength(1)
  })
})

describe("the proxies stay transparent", () => {
  it("transactions / sessions and Db methods work through the validated Db", async () => {
    if (!available) return
    const now = new Date()
    await withTransaction(db, async (session) => {
      await db.collection("workspaces").insertOne(
        { workspaceId: "work_tx", name: "Tx", ownerId: "user_owner", status: "active", createdAt: now },
        { session },
      )
    })
    expect(await db.collection("workspaces").countDocuments({ workspaceId: "work_tx" })).toBe(1)
    expect(db.databaseName).toBe(DB_NAME)
    expect(db.client).toBe(client)
    expect((await db.listCollections({ name: "workspaces" }).toArray()).length).toBe(1)
  })
})
