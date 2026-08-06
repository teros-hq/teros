/**
 * Tests for admin.get-billing-audit (FASE 2e).
 *
 * The endpoint explains how agentHoursUsed was formed: subscription + live
 * consumption recompute + current-period ledger breakdown + snapshots +
 * invoices. Returns DATA (ids/names/numbers), never UI strings.
 *
 * These tests MUST BITE:
 *   - Skipping the admin guard turns the FORBIDDEN assertion red.
 *   - Returning all-time ledger (no period lower-bound) turns the breakdown
 *     count red.
 *   - Mis-wiring the consumption recompute turns the drift assertion red.
 */

import { describe, expect, it } from 'bun:test'
import { boostsCollectionFake } from './_billing-fakes'
import { createGetBillingAuditHandler } from '../../src/handlers/domains/admin/get-billing-audit'

const HOUR_MS = 3_600_000
function hb(h: number): Date {
  return new Date(Date.UTC(2026, 0, 1, h))
}

/** Minimal fluent array-backed collection covering the handler's access patterns. */
function arrayCol(items: any[]) {
  function matches(doc: any, filter: any): boolean {
    for (const [k, v] of Object.entries(filter ?? {})) {
      if (v && typeof v === 'object' && '$gt' in (v as any)) {
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
}

function makeDb(w: World) {
  return {
    collection(name: string) {
      switch (name) {
        case 'billing_subscriptions':
          return arrayCol(w.subs)
        case 'billing_plans':
          return arrayCol(w.plans)
        case 'billing_hour_ledger':
          return arrayCol(w.ledger)
        case 'billing_period_snapshots':
          return arrayCol(w.snapshots)
        case 'billing_invoices':
          return arrayCol(w.invoices)
        case 'billing_hour_boosts':
          return boostsCollectionFake(w.boosts ?? [])
        case 'agent_usage_rollups_user_hourly':
          return {
            aggregate(pipeline: any[]) {
              const match = pipeline[0].$match
              const uid = match['groupKey.userId']
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

function makeUserService(usersById: Record<string, any>) {
  return { async getByUserId(userId: string) { return usersById[userId] ?? null } } as any
}

const adminUser = { userId: 'admin1', role: 'admin', profile: { displayName: 'Admin', email: 'a@x.io' } }
const endUser = { userId: 'A', role: 'user', profile: { displayName: 'Alice', email: 'alice@x.io' } }
const ctx = { userId: 'admin1' } as any

function baseWorld(): World {
  return {
    subs: [
      {
        _id: 'sub_1',
        userId: 'A',
        planId: 'plan_pro',
        status: 'active',
        agentHoursUsed: 5,
        overageHours: 0,
        currentPeriodStart: hb(0),
        currentPeriodEnd: hb(720),
        lastBilledHourBucket: hb(5),
        customAgentHoursLimit: null,
      },
    ],
    plans: [{ _id: 'plan_pro', displayName: 'Pro', agentHoursLimit: 80 }],
    rollups: Array.from({ length: 5 }, (_, i) => ({
      groupKey: { userId: 'A' },
      hourBucket: hb(i + 1),
      userActiveMs: HOUR_MS,
    })),
    ledger: [
      { subscriptionId: 'sub_1', hourBucket: hb(3), fromHourBucket: null, hoursAdded: 3, cumulative: 3, rollupCount: 3, trackerRunId: 'run_1', createdAt: hb(3) },
      { subscriptionId: 'sub_1', hourBucket: hb(5), fromHourBucket: hb(3), hoursAdded: 2, cumulative: 5, rollupCount: 2, trackerRunId: 'run_2', createdAt: hb(5) },
    ],
    snapshots: [
      { subscriptionId: 'sub_1', periodStart: hb(-720), periodEnd: hb(0), agentHoursUsed: 42, agentHoursLimit: 80, overageHours: 0, invoiceId: 'inv_old', createdAt: hb(0) },
    ],
    invoices: [
      { _id: 'inv_old', subscriptionId: 'sub_1', periodStart: hb(-720), periodEnd: hb(0), amount: 89, currency: 'EUR', status: 'pending', paymentMethod: 'manual', createdAt: hb(0) },
    ],
  }
}

describe('admin.get-billing-audit', () => {
  it('rejects non-admin callers', async () => {
    const handler = createGetBillingAuditHandler(
      makeUserService({ admin1: { userId: 'admin1', role: 'user' } }),
      makeDb(baseWorld()),
    )
    await expect(handler(ctx, { subscriptionId: 'sub_1' })).rejects.toThrow('Admin privileges required')
  })

  it('requires subscriptionId or userId', async () => {
    const handler = createGetBillingAuditHandler(makeUserService({ admin1: adminUser }), makeDb(baseWorld()))
    await expect(handler(ctx, {})).rejects.toThrow('subscriptionId or userId is required')
  })

  it('throws NOT_FOUND for an unknown subscription', async () => {
    const handler = createGetBillingAuditHandler(makeUserService({ admin1: adminUser }), makeDb(baseWorld()))
    await expect(handler(ctx, { subscriptionId: 'nope' })).rejects.toThrow('Subscription not found')
  })

  it('returns the full audit breakdown with the exact payload', async () => {
    const handler = createGetBillingAuditHandler(
      makeUserService({ admin1: adminUser, A: endUser }),
      makeDb(baseWorld()),
    )

    const res: any = await handler(ctx, { subscriptionId: 'sub_1' })

    // Subscription (resolved names, effective limit).
    expect(res.subscription.userName).toBe('Alice')
    expect(res.subscription.planName).toBe('Pro')
    expect(res.subscription.agentHoursLimit).toBe(80)
    expect(res.subscription.agentHoursUsed).toBe(5)
    // Live consumption recompute: 5 rollups of 1h in period, up to cursor hb(5).
    expect(res.consumption.expectedHours).toBe(5)
    expect(res.consumption.actualHours).toBe(5)
    expect(res.consumption.driftHours).toBe(0)
    // Ledger breakdown (current period), oldest→newest.
    expect(res.ledgerEntries).toHaveLength(2)
    expect(res.ledgerEntries[0].hoursAdded).toBe(3)
    expect(res.ledgerEntries[1].cumulative).toBe(5)
    expect(res.ledgerTotalCount).toBe(2)
    expect(res.ledgerTruncated).toBe(false)
    // History.
    expect(res.snapshots).toHaveLength(1)
    expect(res.snapshots[0].agentHoursUsed).toBe(42)
    expect(res.invoices[0]._id).toBe('inv_old')
  })

  it('surfaces drift in the live recompute (rollups 5h vs counter 8h)', async () => {
    const w = baseWorld()
    w.subs[0].agentHoursUsed = 8 // tracker over-counted
    const handler = createGetBillingAuditHandler(
      makeUserService({ admin1: adminUser, A: endUser }),
      makeDb(w),
    )

    const res: any = await handler(ctx, { subscriptionId: 'sub_1' })

    expect(res.consumption.expectedHours).toBe(5)
    expect(res.consumption.actualHours).toBe(8)
    expect(res.consumption.driftHours).toBe(3)
  })

  it('excludes prior-period ledger entries from the breakdown', async () => {
    const w = baseWorld()
    // A pre-period ledger entry (hourBucket before currentPeriodStart hb(0)).
    w.ledger.unshift({
      subscriptionId: 'sub_1',
      hourBucket: hb(-10),
      fromHourBucket: null,
      hoursAdded: 99,
      cumulative: 99,
      rollupCount: 1,
      trackerRunId: 'run_old',
      createdAt: hb(-10),
    })
    const handler = createGetBillingAuditHandler(
      makeUserService({ admin1: adminUser, A: endUser }),
      makeDb(w),
    )

    const res: any = await handler(ctx, { subscriptionId: 'sub_1' })

    // BITE: dropping the hourBucket > periodStart filter would include the old
    // 99h entry (count 3) and corrupt the breakdown.
    expect(res.ledgerTotalCount).toBe(2)
    expect(res.ledgerEntries.every((e: any) => e.hoursAdded !== 99)).toBe(true)
  })

  it('resolves the active subscription by userId', async () => {
    const handler = createGetBillingAuditHandler(
      makeUserService({ admin1: adminUser, A: endUser }),
      makeDb(baseWorld()),
    )

    const res: any = await handler(ctx, { userId: 'A' })

    expect(res.subscription._id).toBe('sub_1')
  })
})
