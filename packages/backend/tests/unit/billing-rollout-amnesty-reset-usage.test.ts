/**
 * Migration 20260630_003 — billing-rollout amnesty.
 *
 * Zeroes agentHoursUsed (+ overageHours + warned80At) on EVERY active sub so no
 * user starts blocked under the strict gate (TER-621). The period and — most
 * importantly — lastBilledHourBucket are KEPT (resetting the cursor would make
 * the tracker re-sum old rollups → double-count). Decision Antonio: all active
 * subs, counter only (keep period).
 *
 * Faithful boundary: InMemoryDb. Each assertion is pinned to a mutation it catches.
 */
import { describe, expect, test } from "bun:test"
import type { Db } from "mongodb"
import migration from "../../src/migrations/20260630_003_billing_rollout_amnesty_reset_usage"
import { InMemoryDb } from "./_stripe-test-helpers"

const D = (iso: string) => new Date(iso)
const run = (db: InMemoryDb) => migration.up(db as unknown as Db)
const byId = (db: InMemoryDb, id: string) =>
  db.collection("billing_subscriptions").docs.find((d) => d._id === id) as Record<string, any>

function sub(over: Record<string, any>): Record<string, any> {
  return {
    _id: crypto.randomUUID(),
    userId: "u",
    planId: "plan_starter",
    status: "active",
    customAgentHoursLimit: null,
    customPrice: 0,
    customPriceNote: null,
    agentHoursUsed: 15,
    overageHours: 5,
    warned80At: D("2026-06-10"),
    lastBilledHourBucket: D("2026-06-20"),
    periodStartBucket: D("2026-06-01"),
    currentPeriodStart: D("2026-06-01"),
    currentPeriodEnd: D("2026-07-01"),
    paymentMethod: "manual",
    billingNotes: "",
    createdAt: D("2026-06-01"),
    updatedAt: D("2026-06-01"),
    ...over,
  }
}

describe("migration 20260630_003 — billing rollout amnesty", () => {
  test("zeroes consumed hours on an over-limit active sub, keeps period + cursor", async () => {
    const db = new InMemoryDb()
    db.seed("billing_subscriptions", [sub({ _id: "s1", agentHoursUsed: 15, overageHours: 5 })])

    await run(db)

    const s = byId(db, "s1")
    expect(s.agentHoursUsed).toBe(0) // unblocked
    expect(s.overageHours).toBe(0)
    expect(s.warned80At).toBeNull() // re-armed for the kept period
    // Period left untouched (decision: counter only).
    expect(s.currentPeriodStart).toEqual(D("2026-06-01"))
    expect(s.currentPeriodEnd).toEqual(D("2026-07-01"))
    // CRITICAL: the tracker cursor is preserved — bites a reset that would send it
    // to epoch and re-sum TTL rollups (double-count).
    expect(s.lastBilledHourBucket).toEqual(D("2026-06-20"))
  })

  test("does not write to an active sub already at 0", async () => {
    const db = new InMemoryDb()
    db.seed("billing_subscriptions", [
      sub({ _id: "s0", agentHoursUsed: 0, overageHours: 0, updatedAt: D("2020-01-01") }),
    ])

    await run(db)

    const s = byId(db, "s0")
    expect(s.agentHoursUsed).toBe(0)
    expect(s.updatedAt).toEqual(D("2020-01-01")) // untouched (filter agentHoursUsed > 0)
  })

  test("leaves non-active subs untouched (paused/ended are not amnestied)", async () => {
    // Bites: dropping the status:'active' filter would zero a paused/ended sub —
    // which the gate blocks anyway (NoActiveSubscriptionError), so it must not be touched.
    const db = new InMemoryDb()
    db.seed("billing_subscriptions", [
      sub({ _id: "paused", status: "paused", agentHoursUsed: 20 }),
      sub({ _id: "ended", status: "ended", agentHoursUsed: 30 }),
    ])

    await run(db)

    expect(byId(db, "paused").agentHoursUsed).toBe(20)
    expect(byId(db, "ended").agentHoursUsed).toBe(30)
  })

  test("covers ALL active plans, not just Starter (decision: all active subs)", async () => {
    // Bites: scoping the reset to planId:'plan_starter' would leave a blocked paid user stuck.
    const db = new InMemoryDb()
    db.seed("billing_subscriptions", [sub({ _id: "pro", planId: "plan_pro", agentHoursUsed: 70 })])

    await run(db)

    expect(byId(db, "pro").agentHoursUsed).toBe(0)
  })
})
