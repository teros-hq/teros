/**
 * Edge cases for admin.get-billing-audit not covered by billing-audit-endpoint
 * (FASE 3c): the `limit` clamp (floor + lower/upper bounds), the truncation flag,
 * and a never-billed subscription (null cursor → expected 0, no rollup query).
 *
 * MUST BITE:
 *   - dropping `Math.max(1, ...)` lets limit 0 return 0 rows (truncated wrong),
 *   - dropping `Math.floor(...)` lets a fractional limit slice oddly,
 *   - dropping the `if (cutoff)` guard makes a never-billed sub query rollups
 *     with a null upper bound (and report non-zero expected).
 */

import { describe, expect, it } from "bun:test"
import { boostsCollectionFake } from "./_billing-fakes"
import { createGetBillingAuditHandler } from "../../src/handlers/domains/admin/get-billing-audit"

const HOUR_MS = 3_600_000
function hb(h: number): Date {
  return new Date(Date.UTC(2026, 0, 1, h))
}

function arrayCol(items: any[]) {
  function matches(doc: any, filter: any): boolean {
    for (const [k, v] of Object.entries(filter ?? {})) {
      if (v && typeof v === "object" && "$gt" in (v as any)) {
        if (!(doc[k] > (v as any).$gt)) return false
      } else if (doc[k] !== v) {
        return false
      }
    }
    return true
  }
  function query(filter: any) {
    let rows = items.filter((d) => matches(d, filter))
    return {
      sort(spec: any) {
        const [key, dir] = Object.entries(spec)[0] as [string, number]
        rows = [...rows].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * dir)
        return this
      },
      limit(n: number) {
        rows = rows.slice(0, n)
        return this
      },
      async toArray() {
        return rows
      },
    }
  }
  return {
    async findOne(filter: any) {
      return items.find((d) => matches(d, filter)) ?? null
    },
    async countDocuments(filter: any) {
      return items.filter((d) => matches(d, filter)).length
    },
    find(filter: any) {
      return query(filter)
    },
  }
}

interface World {
  subs: any[]
  plans: any[]
  rollups: any[]
  ledger: any[]
  snapshots: any[]
  invoices: any[]
  boosts?: any[]
  /** Records whether the rollup aggregate was invoked (to prove the cutoff guard). */
  rollupQueried: { value: boolean }
}

function makeDb(w: World) {
  return {
    collection(name: string) {
      switch (name) {
        case "billing_subscriptions":
          return arrayCol(w.subs)
        case "billing_plans":
          return arrayCol(w.plans)
        case "billing_hour_ledger":
          return arrayCol(w.ledger)
        case "billing_period_snapshots":
          return arrayCol(w.snapshots)
        case "billing_invoices":
          return arrayCol(w.invoices)
        case "billing_hour_boosts":
          return boostsCollectionFake(w.boosts ?? [])
        case "agent_usage_rollups_user_hourly":
          return {
            aggregate(pipeline: any[]) {
              w.rollupQueried.value = true
              const match = pipeline[0].$match
              const uid = match["groupKey.userId"]
              const gt: Date = match.hourBucket.$gt
              const lte: Date = match.hourBucket.$lte
              const rows = w.rollups.filter(
                (r) => r.groupKey.userId === uid && r.hourBucket > gt && r.hourBucket <= lte,
              )
              return {
                async toArray() {
                  return [{ totalMs: rows.reduce((a, r) => a + r.userActiveMs, 0) }]
                },
              }
            },
          }
        default:
          return null as any
      }
    },
  } as any
}

const adminUser = {
  userId: "admin1",
  role: "admin",
  profile: { displayName: "Admin", email: "a@x.io" },
}
const ctx = { userId: "admin1" } as any
const userSvc = {
  async getByUserId(id: string) {
    return id === "admin1" ? adminUser : { userId: id, profile: {} }
  },
} as any

/** A sub with `count` current-period ledger entries (buckets hb(1..count)). */
function worldWithLedger(count: number): World {
  return {
    subs: [
      {
        _id: "sub_1",
        userId: "A",
        planId: "plan_pro",
        status: "active",
        agentHoursUsed: count,
        overageHours: 0,
        currentPeriodStart: hb(0),
        currentPeriodEnd: hb(720),
        lastBilledHourBucket: hb(count),
        customAgentHoursLimit: null,
      },
    ],
    plans: [{ _id: "plan_pro", displayName: "Pro", agentHoursLimit: 80 }],
    rollups: [],
    ledger: Array.from({ length: count }, (_, i) => ({
      subscriptionId: "sub_1",
      hourBucket: hb(i + 1),
      fromHourBucket: i === 0 ? null : hb(i),
      hoursAdded: 1,
      cumulative: i + 1,
      rollupCount: 1,
      trackerRunId: `run_${i}`,
      createdAt: hb(i + 1),
    })),
    snapshots: [],
    invoices: [],
    rollupQueried: { value: false },
  }
}

describe("admin.get-billing-audit — limit clamp + truncation", () => {
  it("truncates to the requested limit and flags ledgerTruncated", async () => {
    const w = worldWithLedger(5)
    const handler = createGetBillingAuditHandler(userSvc, makeDb(w))
    const res: any = await handler(ctx, { subscriptionId: "sub_1", limit: 2 })

    expect(res.ledgerEntries).toHaveLength(2)
    expect(res.ledgerTotalCount).toBe(5)
    expect(res.ledgerTruncated).toBe(true)
    // Oldest-first: the first two buckets.
    expect(res.ledgerEntries[0].hourBucket).toBe(hb(1).toISOString())
    expect(res.ledgerEntries[1].hourBucket).toBe(hb(2).toISOString())
  })

  it("does NOT flag truncation when all entries fit", async () => {
    const w = worldWithLedger(3)
    const handler = createGetBillingAuditHandler(userSvc, makeDb(w))
    const res: any = await handler(ctx, { subscriptionId: "sub_1", limit: 10 })
    expect(res.ledgerEntries).toHaveLength(3)
    expect(res.ledgerTruncated).toBe(false)
  })

  it("clamps a limit below 1 up to 1 (Math.max floor)", async () => {
    const w = worldWithLedger(5)
    const handler = createGetBillingAuditHandler(userSvc, makeDb(w))
    const res: any = await handler(ctx, { subscriptionId: "sub_1", limit: 0 })
    // BITE: without Math.max(1, ...), limit 0 returns 0 rows.
    expect(res.ledgerEntries).toHaveLength(1)
    expect(res.ledgerTruncated).toBe(true)
  })

  it("treats a fractional limit as its floor (2.9 → 2 entries)", async () => {
    const w = worldWithLedger(5)
    const handler = createGetBillingAuditHandler(userSvc, makeDb(w))
    const res: any = await handler(ctx, { subscriptionId: "sub_1", limit: 2.9 })
    // Behavioral contract only. NOTE: Math.floor here is an EQUIVALENT MUTANT —
    // Array.slice(0, 2.9) already truncates 2.9 to 2 via ToIntegerOrInfinity, so
    // removing Math.floor does not change observable output. The floor stays as
    // intent-documenting defense; this asserts the contract, not the floor call.
    expect(res.ledgerEntries).toHaveLength(2)
  })

  it("handles an absurdly large limit without error (upper clamp)", async () => {
    const w = worldWithLedger(4)
    const handler = createGetBillingAuditHandler(userSvc, makeDb(w))
    const res: any = await handler(ctx, { subscriptionId: "sub_1", limit: 9_999_999 })
    expect(res.ledgerEntries).toHaveLength(4)
    expect(res.ledgerTruncated).toBe(false)
  })

  it("uses the default limit when none is given", async () => {
    const w = worldWithLedger(3)
    const handler = createGetBillingAuditHandler(userSvc, makeDb(w))
    const res: any = await handler(ctx, { subscriptionId: "sub_1" })
    expect(res.ledgerEntries).toHaveLength(3)
  })
})

describe("admin.get-billing-audit — never-billed subscription", () => {
  it("reports zero expected and does not query rollups when the cursor is null", async () => {
    const w = worldWithLedger(0)
    w.subs[0].lastBilledHourBucket = undefined // never billed
    w.subs[0].agentHoursUsed = 0
    const handler = createGetBillingAuditHandler(userSvc, makeDb(w))

    const res: any = await handler(ctx, { subscriptionId: "sub_1" })

    expect(res.consumption.expectedHours).toBe(0)
    expect(res.consumption.actualHours).toBe(0)
    expect(res.consumption.driftHours).toBe(0)
    expect(res.subscription.lastBilledHourBucket).toBeNull()
    expect(res.ledgerEntries).toHaveLength(0)
    // BITE: dropping the `if (cutoff)` guard would query rollups with a null
    // upper bound for an unbilled sub.
    expect(w.rollupQueried.value).toBe(false)
  })
})
