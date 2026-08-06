/**
 * FK validation for billing teams (FASE 1c).
 *
 * createBillingTeam / updateBillingTeam must reject memberIds that don't map to
 * a real user. Adding a phantom userId would inflate seatCount and bill a seat
 * for nobody (orphan ref).
 *
 * MUST BITE: removing the `userService.getByUserId(memberId)` guard lets the
 * non-existent member through → the handler resolves → the "rejects" assertion
 * fails.
 */

import { describe, expect, it } from 'bun:test'
import {
  createCreateBillingTeamHandler,
  createUpdateBillingTeamHandler,
} from '../../src/handlers/domains/admin/billing-teams'

const ADMIN = { userId: 'admin1', role: 'admin' }
const REAL_USER = { userId: 'u_real', role: 'user' }

/** UserService fake: only admin1 and u_real exist. */
function makeUserService() {
  const users = new Map<string, any>([
    [ADMIN.userId, ADMIN],
    [REAL_USER.userId, REAL_USER],
  ])
  return { getByUserId: async (id: string) => users.get(id) ?? null } as any
}

/** Db fake with the collections the team handlers touch. Records inserts. */
function makeDb(over: { team?: any } = {}) {
  const inserted: { teams: any[]; subs: any[] } = { teams: [], subs: [] }
  const db = {
    collection(name: string) {
      if (name === 'billing_plans') {
        return { async findOne(f: any) { return { _id: f._id, price: 89, displayName: 'Pro' } } }
      }
      if (name === 'billing_teams') {
        return {
          async findOne(f: any) {
            if (f._id && over.team) return over.team
            return null // slug check + already-in-team check → none
          },
          async insertOne(doc: any) { inserted.teams.push(doc); return { insertedId: doc._id } },
          async updateOne() { return { matchedCount: 1 } },
        }
      }
      if (name === 'billing_subscriptions') {
        return {
          async findOne() { return null },
          async insertOne(doc: any) { inserted.subs.push(doc); return { insertedId: doc._id } },
          async updateOne() { return { matchedCount: 1 } },
        }
      }
      return null as any
    },
  } as any
  return { db, inserted }
}

const ctx = { userId: ADMIN.userId } as any

async function expectHandlerError(p: Promise<unknown>, code: string, messageIncludes: string) {
  try {
    await p
    throw new Error('expected handler to throw')
  } catch (err: any) {
    expect(err.code).toBe(code)
    expect(err.message).toContain(messageIncludes)
  }
}

describe('billing teams — FK validation', () => {
  it('createBillingTeam rejects a non-existent member', async () => {
    const { db, inserted } = makeDb()
    const handler = createCreateBillingTeamHandler(makeUserService(), db)

    await expectHandlerError(
      handler(ctx, { name: 'T', slug: 't', planId: 'plan_pro', maxSeats: 5, memberIds: ['u_ghost'] }),
      'INVALID_MEMBER',
      'u_ghost',
    )
    // Nothing was written — fail fast before insert.
    expect(inserted.teams).toHaveLength(0)
    expect(inserted.subs).toHaveLength(0)
  })

  it('createBillingTeam accepts real members', async () => {
    const { db, inserted } = makeDb()
    const handler = createCreateBillingTeamHandler(makeUserService(), db)

    const res = await handler(ctx, {
      name: 'T',
      slug: 't',
      planId: 'plan_pro',
      maxSeats: 5,
      memberIds: [REAL_USER.userId],
    })

    expect(res.team.seatCount).toBe(1)
    expect(inserted.teams).toHaveLength(1)
  })

  it('updateBillingTeam.addMemberIds rejects a non-existent member', async () => {
    const team = { _id: 'team_t', planId: 'plan_pro', memberIds: [], status: 'active' }
    const { db } = makeDb({ team })
    const handler = createUpdateBillingTeamHandler(makeUserService(), db)

    await expectHandlerError(
      handler(ctx, { teamId: 'team_t', addMemberIds: ['u_ghost'] }),
      'INVALID_MEMBER',
      'u_ghost',
    )
  })
})
