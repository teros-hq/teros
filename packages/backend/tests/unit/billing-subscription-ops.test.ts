/**
 * changeUserPlanImmediate — atomicity of the immediate plan change (TER-625).
 *
 * Teros uses NO Mongo transactions, so changeUserPlanImmediate closes the old sub
 * FIRST (the partial unique index billing_sub_one_active forbids two active subs)
 * and then inserts the new one. A failed insert must NOT orphan the user (the old
 * sub is already 'ended'); it compensates by re-opening the old sub, mirroring the
 * codebase's compensation-over-transaction pattern.
 *
 * MUST BITE: dropping the catch leaves the old sub 'ended' → the user has no active
 * subscription → the gate blocks them.
 */
import { describe, expect, it } from "bun:test"
import type { Db } from "mongodb"
import { changeUserPlanImmediate } from "../../src/services/billing-subscription-ops"

function activeSub(over: Record<string, any> = {}) {
  const now = new Date("2026-06-01T00:00:00Z")
  return {
    _id: "sub_old",
    userId: "u1",
    planId: "plan_pro",
    customAgentHoursLimit: null,
    customPrice: null,
    customPriceNote: null,
    agentHoursUsed: 12,
    overageHours: 0,
    currentPeriodStart: now,
    currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
    status: "active",
    startDate: now,
    endDate: null,
    cancelAtPeriodEnd: false,
    paymentMethod: "manual",
    billingNotes: "",
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

/** Minimal faithful subs collection: the DB holds its OWN copies (a read returns a
 *  separate object, like real Mongo), so updateOne never mutates the caller's
 *  `active` reference. */
function makeDb(store: any[], opts: { insertThrows?: boolean } = {}) {
  const subsCol = {
    async updateOne(filter: any, update: any) {
      const s = store.find((x) => x._id === filter._id)
      if (s) Object.assign(s, update.$set)
      return { matchedCount: s ? 1 : 0 }
    },
    async insertOne(doc: any) {
      if (opts.insertThrows) throw new Error("transient insert failure")
      store.push({ ...doc })
      return { insertedId: doc._id }
    },
  }
  return {
    collection(name: string) {
      if (name === "billing_subscriptions") return subsCol
      return { async findOne() { return null } }
    },
  } as unknown as Db
}

describe("changeUserPlanImmediate — atomicity (TER-625)", () => {
  it("re-opens the old sub when the new-sub insert fails, leaving no orphaned user", async () => {
    const active = activeSub()
    const store: any[] = [{ ...active }] // the DB holds its own copy
    const db = makeDb(store, { insertThrows: true })

    await expect(
      changeUserPlanImmediate(db, active as any, "plan_max", new Date("2026-06-10T00:00:00Z")),
    ).rejects.toThrow(/transient insert failure/)

    // The old sub is re-OPENED (not left 'ended') → the user keeps an active sub.
    expect(store).toHaveLength(1)
    expect(store[0]._id).toBe("sub_old")
    expect(store[0].status).toBe("active")
    expect(store[0].endDate ?? null).toBeNull()
    expect(store[0].cancelAtPeriodEnd).toBe(false)
    // MUST BITE: dropping the catch leaves sub_old 'ended' → orphaned user.
  })

  it("grants normally when the insert succeeds (old ended, new active)", async () => {
    const active = activeSub()
    const store: any[] = [{ ...active }]
    const db = makeDb(store)

    const newId = await changeUserPlanImmediate(
      db,
      active as any,
      "plan_max",
      new Date("2026-06-10T00:00:00Z"),
    )

    expect(store.find((s) => s._id === "sub_old")?.status).toBe("ended")
    const created = store.find((s) => s._id === newId)
    expect(created?.status).toBe("active")
    expect(created?.planId).toBe("plan_max")
    expect(created?.agentHoursUsed).toBe(0)
  })
})
