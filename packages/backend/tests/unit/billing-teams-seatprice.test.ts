/**
 * Manual per-seat price override for billing teams (FASE 11, decision E).
 *
 * FASE 7's automatic volume discount was CANCELLED — a team's seat price is set
 * by hand (sales-negotiated). createBillingTeam / updateBillingTeam accept an
 * optional customSeatPrice; the effective seatPrice = customSeatPrice ?? plan.price
 * (getEffectiveSeatPrice, single source of truth). A plan change PRESERVES an
 * existing override; clearing it (null) falls back to the plan price.
 *
 * MUST BITE:
 *   - the old `seatPrice = plan.price` on plan change → the "preserves override"
 *     test goes red (it would become the plan price).
 *   - dropping the override on create → the "create with override" test red.
 *   - dropping the validator → the negative-override test no longer throws.
 */

import { describe, expect, it } from 'bun:test'
import {
  createCreateBillingTeamHandler,
  createUpdateBillingTeamHandler,
} from '../../src/handlers/domains/admin/billing-teams'

const ADMIN = { userId: 'admin1', role: 'admin' }
const PRICES: Record<string, number> = { plan_pro: 89, plan_max: 179, plan_basic: 0 }

function makeUserService() {
  return { getByUserId: async (id: string) => (id === ADMIN.userId ? ADMIN : null) } as any
}

function makeDb(team?: any) {
  const teamStore = team ? { ...team } : null
  let lastInsert: any = null
  const db = {
    collection(name: string) {
      if (name === 'billing_plans') {
        return {
          async findOne(f: any) {
            return { _id: f._id, price: PRICES[f._id] ?? 89, displayName: f._id, name: f._id }
          },
        }
      }
      if (name === 'billing_teams') {
        return {
          async findOne(f: any) {
            if (f.slug !== undefined) return null // create slug-uniqueness check
            if (f._id && f.memberIds !== undefined) return null // already-in-team check
            if (f._id) return teamStore
            return null
          },
          async insertOne(doc: any) {
            lastInsert = doc
            return { insertedId: doc._id }
          },
          async updateOne(_f: any, u: any) {
            if (teamStore) Object.assign(teamStore, u.$set)
            return { matchedCount: 1 }
          },
        }
      }
      if (name === 'billing_subscriptions') {
        return {
          async findOne() { return null },
          async insertOne() { return {} },
          async updateOne() { return { matchedCount: 1 } },
          async updateMany() { return { matchedCount: 0 } },
        }
      }
      return null as any
    },
  } as any
  return { db, getInsert: () => lastInsert, getTeam: () => teamStore }
}

const ctx = { userId: ADMIN.userId } as any

async function expectHandlerError(p: Promise<unknown>, code: string) {
  try {
    await p
    throw new Error('expected handler to throw')
  } catch (err: any) {
    expect(err.code).toBe(code)
  }
}

describe('billing teams — manual seat-price override (FASE 11)', () => {
  it('create applies a manual override below the plan price', async () => {
    const { db, getInsert } = makeDb()
    const handler = createCreateBillingTeamHandler(makeUserService(), db)

    const res = await handler(ctx, { name: 'T', slug: 't', planId: 'plan_pro', maxSeats: 5, customSeatPrice: 50 })

    expect(res.team.seatPrice).toBe(50)
    expect(res.team.customSeatPrice).toBe(50)
    expect(getInsert().seatPrice).toBe(50)
    expect(getInsert().customSeatPrice).toBe(50)
  })

  it('create without an override uses the plan price', async () => {
    const { db } = makeDb()
    const handler = createCreateBillingTeamHandler(makeUserService(), db)

    const res = await handler(ctx, { name: 'T', slug: 't', planId: 'plan_pro', maxSeats: 5 })

    expect(res.team.seatPrice).toBe(89)
    expect(res.team.customSeatPrice).toBeNull()
  })

  it('create rejects a non-finite / negative override', async () => {
    const { db } = makeDb()
    const handler = createCreateBillingTeamHandler(makeUserService(), db)
    await expectHandlerError(
      handler(ctx, { name: 'T', slug: 't', planId: 'plan_pro', maxSeats: 5, customSeatPrice: -10 }),
      'INVALID_INPUT',
    )
  })

  it('update sets a manual override', async () => {
    const { db, getTeam } = makeDb({ _id: 'team_t', planId: 'plan_pro', seatPrice: 89, customSeatPrice: null, memberIds: [], status: 'active' })
    const handler = createUpdateBillingTeamHandler(makeUserService(), db)

    const res = await handler(ctx, { teamId: 'team_t', customSeatPrice: 60 })

    expect(res.team?.seatPrice).toBe(60)
    expect(res.team?.customSeatPrice).toBe(60)
    expect(getTeam().seatPrice).toBe(60)
  })

  it('a plan change PRESERVES an existing override (decision E)', async () => {
    const { db, getTeam } = makeDb({ _id: 'team_t', planId: 'plan_pro', seatPrice: 60, customSeatPrice: 60, memberIds: [], status: 'active' })
    const handler = createUpdateBillingTeamHandler(makeUserService(), db)

    // plan_pro (89) → plan_max (179): MUST BITE — the old code set seatPrice=179.
    const res = await handler(ctx, { teamId: 'team_t', planId: 'plan_max' })

    expect(res.team?.planId).toBe('plan_max')
    expect(res.team?.seatPrice).toBe(60)
    expect(getTeam().seatPrice).toBe(60)
  })

  it('clearing the override (null) falls back to the plan price', async () => {
    const { db } = makeDb({ _id: 'team_t', planId: 'plan_pro', seatPrice: 60, customSeatPrice: 60, memberIds: [], status: 'active' })
    const handler = createUpdateBillingTeamHandler(makeUserService(), db)

    const res = await handler(ctx, { teamId: 'team_t', customSeatPrice: null })

    expect(res.team?.seatPrice).toBe(89)
    expect(res.team?.customSeatPrice).toBeNull()
  })

  it('a plan change without an override uses the new plan price', async () => {
    const { db } = makeDb({ _id: 'team_t', planId: 'plan_pro', seatPrice: 89, customSeatPrice: null, memberIds: [], status: 'active' })
    const handler = createUpdateBillingTeamHandler(makeUserService(), db)

    const res = await handler(ctx, { teamId: 'team_t', planId: 'plan_max' })

    expect(res.team?.seatPrice).toBe(179)
  })
})
