/**
 * Integration test: 20261017_011_jsonschema_validators (GOV-2).
 *
 * The migration installs warn-only validators. To prove the schemas fit what
 * the code really writes, the test flips them to validationAction 'error'
 * and drives the REAL creation paths (UserService.createUser,
 * WorkspaceService, seedBillingPlans, createDefaultSubscription,
 * changeUserPlanImmediate, BillingResetCron, chargeOneOffInvoice) with fakes
 * only for external dependencies (volumes, Stripe). Several of those paths
 * swallow write errors, so the test asserts that the documents exist rather
 * than that nothing threw. Obviously wrong documents must be rejected.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import { UserService } from "../../src/auth/user-service"
import { COLLECTION_SCHEMAS } from "../../src/db/schemas"
import migration from "../../src/migrations/20261017_011_jsonschema_validators"
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
const DB_NAME = `teros_test_jsonschema_${Date.now()}`
const NAMES = Object.keys(COLLECTION_SCHEMAS)

let client: MongoClient
let db: Db
let available = false

const stubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => stubLogger,
}

let volumeSeq = 0
const fakeVolumes = {
  createWorkspace: async () => ({ volumeId: `vol_work_test${++volumeSeq}` }),
  deleteWorkspace: async () => {},
} as unknown as VolumeService

async function collectionOptions(name: string) {
  const [info] = await db.listCollections({ name }).toArray()
  return (info as { options?: Record<string, unknown> } | undefined)?.options ?? {}
}

async function setAction(action: "warn" | "error") {
  for (const name of NAMES) await db.command({ collMod: name, validationAction: action })
}

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    await db.dropDatabase()
    available = true
  } catch {
    console.warn("[jsonschema validators test] Mongo unreachable — skipping")
  }
})

afterAll(async () => {
  if (available) {
    await db.dropDatabase()
    await client.close()
  }
})

describe("20261017_011_jsonschema_validators", () => {
  it("creates missing collections with warn-only, moderate validators", async () => {
    if (!available) return
    // One collection pre-exists (collMod path), the rest don't (createCollection path)
    await db.collection("users").insertOne({ legacy: true })

    await migration.up(db)

    for (const name of NAMES) {
      const opts = await collectionOptions(name)
      expect(opts.validationAction).toBe("warn")
      expect(opts.validationLevel).toBe("moderate")
      expect(opts.validator).toEqual({ $jsonSchema: COLLECTION_SCHEMAS[name] })
    }
    await db.collection("users").deleteMany({})
  })

  it("warn mode accepts an invalid document", async () => {
    if (!available) return
    await db.collection("users").insertOne({ userId: "user_bad" })
    expect(await db.collection("users").countDocuments({ userId: "user_bad" })).toBe(1)
    await db.collection("users").deleteMany({ userId: "user_bad" })
  })

  it("is idempotent", async () => {
    if (!available) return
    await migration.up(db)
    expect((await collectionOptions("workspaces")).validationAction).toBe("warn")
  })

  describe("with validationAction 'error'", () => {
    beforeAll(async () => {
      if (!available) return
      await setAction("error")
      await ensureBillingIndexes(db)
    })

    afterAll(async () => {
      if (available) await setAction("warn")
    })

    it("seeded billing plans validate", async () => {
      if (!available) return
      await seedBillingPlans(db)
      expect(await db.collection("billing_plans").countDocuments()).toBeGreaterThan(0)
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
      expect(
        await db.collection("workspaces").countDocuments({ ownerId: user.userId, type: "private" }),
      ).toBe(1)
      expect(await getActiveSubscription(db, user.userId)).not.toBeNull()

      // OAuth-style signup without a display name or avatar (undefined fields)
      const oauth = await users.createUser({
        email: "oauth@example.com",
        displayName: undefined as unknown as string,
        avatarUrl: undefined,
      })
      expect(await db.collection("users").countDocuments({ userId: oauth.userId })).toBe(1)
    })

    it("a shared workspace validates", async () => {
      if (!available) return
      const ws = await new WorkspaceService(db, fakeVolumes).createWorkspace("user_owner", {
        name: "Shared",
      })
      expect(await db.collection("workspaces").countDocuments({ workspaceId: ws.workspaceId })).toBe(1)
    })

    it("a plan change, a cancellation renewal and a one-off invoice validate", async () => {
      if (!available) return
      const users = new UserService(db)
      const user = await users.createUser({ email: "billing@example.com", displayName: "Billing" })
      const active = (await getActiveSubscription(db, user.userId)) as BillingSubscription

      // Immediate plan change: closes the sub ($set) and inserts a new one
      const newSubId = await changeUserPlanImmediate(db, active, "plan_pro", new Date())
      expect(await db.collection("billing_subscriptions").countDocuments({ _id: newSubId } as never)).toBe(1)

      // Expire it with a pending cancellation: the reset cron upserts the
      // period invoice, closes the sub and opens a fresh starter one
      const past = new Date(Date.now() - 2 * 86_400_000)
      await db.collection("billing_subscriptions").updateOne(
        { _id: newSubId } as never,
        { $set: { currentPeriodEnd: past, cancelAtPeriodEnd: true } },
      )
      const cron = new BillingResetCron(db, stubLogger as never, null)
      await cron.runOnce()
      expect(
        await db
          .collection("billing_invoices")
          .countDocuments({ subscriptionId: newSubId, kind: "subscription" }),
      ).toBe(1)
      const starter = await getActiveSubscription(db, user.userId)
      expect(starter?._id).not.toBe(newSubId)
      expect(starter?.planId).toBeTruthy()

      // One-off (boost) invoice through the real charge path, fake Stripe
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
    })

    it("rejects a user without profile.email", async () => {
      if (!available) return
      await expect(
        db.collection("users").insertOne({
          userId: "user_noemail",
          profile: { displayName: "No Email" },
          status: "active",
          role: "user",
        }),
      ).rejects.toThrow("Document failed validation")
    })

    it("rejects a subscription with an unknown status", async () => {
      if (!available) return
      const now = new Date()
      await expect(
        db.collection("billing_subscriptions").insertOne({
          userId: "user_x",
          planId: "plan_seed",
          status: "trialing",
          currentPeriodStart: now,
          currentPeriodEnd: now,
        }),
      ).rejects.toThrow("Document failed validation")
    })

    it("rejects a workspace without an owner and an invoice with a string amount", async () => {
      if (!available) return
      await expect(
        db.collection("workspaces").insertOne({ workspaceId: "work_x", name: "X", status: "active" }),
      ).rejects.toThrow("Document failed validation")
      const now = new Date()
      await expect(
        db.collection("billing_invoices").insertOne({
          subscriptionId: "sub_x",
          userId: "user_x",
          periodStart: now,
          periodEnd: now,
          amount: "5",
          currency: "EUR",
          status: "paid",
        }),
      ).rejects.toThrow("Document failed validation")
    })

    it("accepts the ISO-string dates workspaces still use (GOV-3)", async () => {
      if (!available) return
      const iso = new Date().toISOString()
      await db.collection("workspaces").insertOne({
        workspaceId: "work_iso",
        name: "Legacy",
        ownerId: "user_owner",
        status: "active",
        createdAt: iso,
        updatedAt: iso,
      })
    })
  })

  it("down() removes the validators", async () => {
    if (!available) return
    await migration.down!(db)
    for (const name of NAMES) {
      const opts = await collectionOptions(name)
      expect(opts.validator ?? {}).toEqual({})
      expect(opts.validationLevel ?? "off").toBe("off")
    }
    await db.collection("users").insertOne({ userId: "user_free_form" })
  })
})
