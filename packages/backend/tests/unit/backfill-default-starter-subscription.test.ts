/**
 * Migration 20260630_002 — backfill an active Starter subscription for every
 * user without one. Safety net for TER-621 (the gate now blocks the Teros model
 * when no active sub exists), so this must provision exactly the right users and
 * never touch a live subscription.
 *
 * Faithful boundary: InMemoryDb (real distinct/find/insert). Each assertion is
 * pinned to a mutation it would catch — noted inline.
 */
import { describe, expect, test } from "bun:test"
import type { Db } from "mongodb"
import { MongoServerError } from "mongodb"
import migration from "../../src/migrations/20260630_002_backfill_default_starter_subscription"
import { STARTER_PLAN_ID } from "../../src/models/billing"
import { InMemoryDb } from "./_stripe-test-helpers"

const D = (iso: string) => new Date(iso)
const run = (db: InMemoryDb) => migration.up(db as unknown as Db)

/** A subscription doc carrying the fields the migration + queries read. */
function sub(over: Record<string, any>): Record<string, any> {
  return {
    _id: crypto.randomUUID(),
    planId: "plan_growth",
    status: "active",
    customAgentHoursLimit: null,
    customPrice: null,
    customPriceNote: null,
    agentHoursUsed: 0,
    overageHours: 0,
    currentPeriodStart: D("2026-06-01"),
    currentPeriodEnd: D("2026-07-01"),
    startDate: D("2026-06-01"),
    endDate: null,
    paymentMethod: "manual",
    billingNotes: "",
    createdAt: D("2026-06-01"),
    updatedAt: D("2026-06-01"),
    ...over,
  }
}

/** Capture console.error calls for the duration of a run, then restore it. */
function captureErrors() {
  const calls: any[][] = []
  const original = console.error
  console.error = (...args: any[]) => {
    calls.push(args)
  }
  return {
    calls,
    restore: () => {
      console.error = original
    },
  }
}

const activeSubs = (db: InMemoryDb, userId: string) =>
  db
    .collection("billing_subscriptions")
    .docs.filter((d) => d.userId === userId && d.status === "active")
const allSubs = (db: InMemoryDb, userId: string) =>
  db.collection("billing_subscriptions").docs.filter((d) => d.userId === userId)

describe("migration 20260630_002 — backfill Starter for users without an active sub", () => {
  test("user with NO subscription at all → gets exactly one active Starter", async () => {
    const db = new InMemoryDb()
    db.seed("users", [{ userId: "u_none" }])

    await run(db)

    const act = activeSubs(db, "u_none")
    expect(act).toHaveLength(1) // bites: never provisioning / provisioning twice
    expect(act[0].planId).toBe(STARTER_PLAN_ID) // bites: wrong plan
    expect(act[0].status).toBe("active")
    expect(act[0].customPrice).toBe(0) // Starter is BETA-free
    // A real one-month window so the gate has a cycle to meter against.
    expect(act[0].currentPeriodEnd.getTime()).toBeGreaterThan(act[0].currentPeriodStart.getTime())
  })

  test("user with only an ENDED sub → gets a fresh active Starter (the TER-621 case)", async () => {
    // Mutation guard for the distinct({status:'active'}) FILTER: if the migration
    // keyed off ALL userIds in billing_subscriptions (dropping the status filter),
    // this user would be wrongly excluded and left blocked by TER-621.
    const db = new InMemoryDb()
    db.seed("users", [{ userId: "u_ended" }])
    db.seed("billing_subscriptions", [
      sub({ userId: "u_ended", planId: "plan_pro", status: "ended" }),
    ])

    await run(db)

    expect(activeSubs(db, "u_ended")).toHaveLength(1)
    expect(activeSubs(db, "u_ended")[0].planId).toBe(STARTER_PLAN_ID)
    // The historical ended sub is left untouched alongside the new active one.
    expect(allSubs(db, "u_ended")).toHaveLength(2)
  })

  test("user with an active PAID sub → left exactly as-is (no duplicate, no downgrade)", async () => {
    const db = new InMemoryDb()
    db.seed("users", [{ userId: "u_growth" }])
    db.seed("billing_subscriptions", [
      sub({
        _id: "g1",
        userId: "u_growth",
        planId: "plan_growth",
        status: "active",
        customPrice: 89,
      }),
    ])

    await run(db)

    const act = activeSubs(db, "u_growth")
    expect(act).toHaveLength(1) // bites: dropping the filter → second active sub
    expect(act[0]._id).toBe("g1") // it's the SAME sub, not a replacement
    expect(act[0].planId).toBe("plan_growth") // bites: downgrading a live sub to Starter
    expect(act[0].customPrice).toBe(89) // untouched
  })

  test("mixed batch: only users missing an active sub are provisioned", async () => {
    const db = new InMemoryDb()
    db.seed("users", [{ userId: "a" }, { userId: "b" }, { userId: "c" }])
    db.seed("billing_subscriptions", [
      sub({ userId: "b", status: "active", planId: "plan_pro" }), // already covered
      sub({ userId: "c", status: "paused", planId: "plan_growth" }), // paused → needs Starter
    ])

    await run(db)

    expect(activeSubs(db, "a")[0]?.planId).toBe(STARTER_PLAN_ID)
    expect(activeSubs(db, "b")).toHaveLength(1)
    expect(activeSubs(db, "b")[0].planId).toBe("plan_pro") // untouched
    expect(activeSubs(db, "c")[0]?.planId).toBe(STARTER_PLAN_ID) // paused user now active on Starter
  })

  test("idempotent: a second run provisions nothing new", async () => {
    const db = new InMemoryDb()
    db.seed("users", [{ userId: "u_none" }, { userId: "u_growth" }])
    db.seed("billing_subscriptions", [sub({ _id: "g1", userId: "u_growth", status: "active" })])

    await run(db)
    const afterFirst = db.collection("billing_subscriptions").docs.length

    await run(db)

    expect(db.collection("billing_subscriptions").docs.length).toBe(afterFirst) // no second Starter
    expect(activeSubs(db, "u_none")).toHaveLength(1)
  })

  test("a concurrent active sub (E11000) is swallowed SILENTLY as a no-op", async () => {
    // Simulates the partial unique index billing_sub_one_active rejecting a sub
    // provisioned by a racing path. A duplicate active sub means "already done",
    // so it must NOT be logged as a failure. Bites: removing the `code === 11000`
    // branch routes the race to the generic failure path → console.error fires.
    const db = new InMemoryDb()
    db.seed("users", [{ userId: "race" }, { userId: "ok" }])
    const col = db.collection("billing_subscriptions")
    const orig = col.insertOne.bind(col)
    col.insertOne = async (doc: any) => {
      if (doc.userId === "race") {
        const e = new MongoServerError({ message: "E11000 duplicate key" })
        ;(e as any).code = 11000
        throw e
      }
      return orig(doc)
    }

    const errors = captureErrors()
    try {
      await run(db) // must not throw
    } finally {
      errors.restore()
    }

    expect(activeSubs(db, "ok")[0]?.planId).toBe(STARTER_PLAN_ID) // batch continued
    expect(activeSubs(db, "race")).toHaveLength(0) // rejected, not retried
    // A lost race is expected idempotency, not a failure — nothing logged.
    expect(errors.calls).toHaveLength(0)
  })

  test("a per-user write failure is logged and does NOT abort the batch", async () => {
    // Bites: removing the per-user try/catch would let one bad write throw out of
    // the loop and abort the whole startup migration. The failure is logged loud.
    const db = new InMemoryDb()
    db.seed("users", [{ userId: "boom" }, { userId: "ok" }])
    const col = db.collection("billing_subscriptions")
    const orig = col.insertOne.bind(col)
    col.insertOne = async (doc: any) => {
      if (doc.userId === "boom") throw new Error("transient write error")
      return orig(doc)
    }

    const errors = captureErrors()
    try {
      await run(db) // must not throw
    } finally {
      errors.restore()
    }

    expect(activeSubs(db, "ok")[0]?.planId).toBe(STARTER_PLAN_ID)
    expect(activeSubs(db, "boom")).toHaveLength(0)
    // A genuine write failure IS surfaced (loud) for the one bad user.
    expect(errors.calls.some((args) => String(args[0]).includes("boom"))).toBe(true)
  })
})
