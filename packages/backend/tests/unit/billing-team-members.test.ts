/**
 * TER-596 T1 — admin.get-team-members.
 *
 * Resolves a team's memberIds into name/role/plan + live usage (hours used,
 * effective limit incl. active boosts, % consumed), flags the owner, and
 * resolves the owner identity even when they are not a member. Returns DATA;
 * the window composes the UI. Each assertion checks the exact resolved shape so
 * a mutation (ignore the boost, floor the %, drop isOwner) turns it red.
 */

import { describe, expect, it } from 'bun:test'
import { InMemoryDb } from './_stripe-test-helpers'
import { createGetTeamMembersHandler } from '../../src/handlers/domains/admin/billing-teams'

const PERIOD_START = new Date('2026-06-01T00:00:00Z')
const PERIOD_END = new Date('2026-07-01T00:00:00Z')
const FOREVER_START = new Date('2000-01-01T00:00:00Z')
const FOREVER_END = new Date('2100-01-01T00:00:00Z')

const ctx = (userId: string) => ({ userId }) as any

const PLANS = [
  { _id: 'plan_pro', name: 'pro', displayName: 'Pro', price: 89, currency: 'EUR', agentHoursLimit: 80 },
  { _id: 'plan_growth', name: 'growth', displayName: 'Growth', price: 89, currency: 'EUR', agentHoursLimit: 40 },
]

const USERS = [
  { userId: 'owner1', role: 'admin', profile: { displayName: 'Owner', email: 'o@x.io' } },
  { userId: 'm1', role: 'user', profile: { displayName: 'Member One', email: 'm1@x.io' } },
  { userId: 'm2', role: 'user', profile: { displayName: 'Member Two', email: 'm2@x.io' } },
  { userId: 'stranger', role: 'user', profile: { displayName: 'Nope', email: 'n@x.io' } },
]

function fakeUserService(users = USERS) {
  return {
    async getByUserId(id: string) {
      return users.find((u) => u.userId === id) ?? null
    },
    async listUsers({ role }: { role?: string } = {}) {
      const us = users.filter((u) => !role || u.role === role)
      return { users: us, total: us.length }
    },
  } as any
}

function sub(over: Record<string, any> = {}) {
  return {
    _id: 'subX',
    userId: 'm1',
    planId: 'plan_pro',
    status: 'active',
    agentHoursUsed: 70,
    customAgentHoursLimit: null,
    customPrice: null,
    overageHours: 0,
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
    paymentMethod: 'manual',
    billingNotes: '',
    teamId: 'team_acme',
    createdAt: PERIOD_START,
    updatedAt: PERIOD_START,
    ...over,
  }
}

function team(over: Record<string, any> = {}) {
  return {
    _id: 'team_acme',
    name: 'Acme',
    slug: 'acme',
    planId: 'plan_growth',
    seatPrice: 75,
    customSeatPrice: 75,
    seatCount: 2,
    maxSeats: 10,
    status: 'active',
    paymentMethod: 'manual',
    billingEmail: 'billing@acme.io',
    ownerId: 'owner1',
    memberIds: ['m1', 'm2'],
    createdAt: PERIOD_START,
    updatedAt: PERIOD_START,
    ...over,
  }
}

function makeDb(seed: Record<string, any[]>) {
  const db = new InMemoryDb()
  for (const [col, docs] of Object.entries(seed)) db.seed(col, docs)
  return db
}

describe('admin.get-team-members', () => {
  it('rejects a non-admin caller', async () => {
    const db = makeDb({ billing_teams: [team()] })
    const handler = createGetTeamMembersHandler(fakeUserService(), db as any)
    await expect(handler(ctx('m1'), { teamId: 'team_acme' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('requires a teamId', async () => {
    const db = makeDb({ billing_teams: [team()] })
    const handler = createGetTeamMembersHandler(fakeUserService(), db as any)
    await expect(handler(ctx('owner1'), {})).rejects.toMatchObject({ code: 'MISSING_FIELDS' })
  })

  it('404s an unknown team', async () => {
    const db = makeDb({ billing_teams: [] })
    const handler = createGetTeamMembersHandler(fakeUserService(), db as any)
    await expect(handler(ctx('owner1'), { teamId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('resolves members with name/role/plan and live usage', async () => {
    const db = makeDb({
      billing_teams: [team()],
      billing_plans: PLANS,
      // m1: Pro 80h base, 70h used → 88% (a floor mutation gives 87).
      billing_subscriptions: [sub({ _id: 's1', userId: 'm1', agentHoursUsed: 70 })],
    })
    const handler = createGetTeamMembersHandler(fakeUserService(), db as any)
    const res = await handler(ctx('owner1'), { teamId: 'team_acme' })

    expect(res.members).toHaveLength(2)
    const m1 = res.members.find((m: any) => m.userId === 'm1')
    expect(m1).toEqual({
      userId: 'm1',
      userName: 'Member One',
      userEmail: 'm1@x.io',
      role: 'user',
      isOwner: false,
      planId: 'plan_pro',
      planName: 'Pro',
      agentHoursUsed: 70,
      agentHoursLimit: 80,
      usagePct: 88,
      subscriptionStatus: 'active',
    })
  })

  it('counts active boost hours in the effective limit and the %', async () => {
    const db = makeDb({
      billing_teams: [team()],
      billing_plans: PLANS,
      billing_subscriptions: [sub({ _id: 's1', userId: 'm1', agentHoursUsed: 70 })],
      // +40h active boost → effective 120h, 70/120 = 58% (not 80h / 88%).
      billing_hour_boosts: [
        {
          _id: 'b1',
          userId: 'm1',
          subscriptionId: 's1',
          hours: 40,
          periodStart: FOREVER_START,
          periodEnd: FOREVER_END,
          status: 'active',
          grantedBy: 'owner1',
          accessRequestId: 'r1',
          createdAt: FOREVER_START,
        },
      ],
    })
    const handler = createGetTeamMembersHandler(fakeUserService(), db as any)
    const res = await handler(ctx('owner1'), { teamId: 'team_acme' })
    const m1 = res.members.find((m: any) => m.userId === 'm1')
    // MUST BITE: ignoring the boost reports 80h / 88% instead of 120h / 58%.
    expect(m1).toMatchObject({ agentHoursLimit: 120, usagePct: 58 })
  })

  it('renders a member with no active subscription as null usage', async () => {
    const db = makeDb({
      billing_teams: [team()],
      billing_plans: PLANS,
      billing_subscriptions: [sub({ _id: 's1', userId: 'm1' })], // m2 has none
    })
    const handler = createGetTeamMembersHandler(fakeUserService(), db as any)
    const res = await handler(ctx('owner1'), { teamId: 'team_acme' })
    const m2 = res.members.find((m: any) => m.userId === 'm2')
    expect(m2).toEqual({
      userId: 'm2',
      userName: 'Member Two',
      userEmail: 'm2@x.io',
      role: 'user',
      isOwner: false,
      planId: null,
      planName: null,
      agentHoursUsed: null,
      agentHoursLimit: null,
      usagePct: null,
      subscriptionStatus: null,
    })
  })

  it('flags the owner when they are also a member', async () => {
    const db = makeDb({
      billing_teams: [team({ memberIds: ['owner1', 'm1'] })],
      billing_plans: PLANS,
      billing_subscriptions: [],
    })
    const handler = createGetTeamMembersHandler(fakeUserService(), db as any)
    const res = await handler(ctx('owner1'), { teamId: 'team_acme' })
    // MUST BITE: dropping the isOwner flag would mark the owner row as false.
    expect(res.members.find((m: any) => m.userId === 'owner1').isOwner).toBe(true)
    expect(res.members.find((m: any) => m.userId === 'm1').isOwner).toBe(false)
  })

  it('resolves the owner identity even when the owner is not a member', async () => {
    const db = makeDb({
      billing_teams: [team()], // owner1 not in memberIds ['m1','m2']
      billing_plans: PLANS,
      billing_subscriptions: [],
    })
    const handler = createGetTeamMembersHandler(fakeUserService(), db as any)
    const res = await handler(ctx('owner1'), { teamId: 'team_acme' })
    expect(res.owner).toEqual({ userId: 'owner1', userName: 'Owner', userEmail: 'o@x.io' })
    expect(res.members.map((m: any) => m.userId).sort()).toEqual(['m1', 'm2'])
  })

  it('returns the team summary with its plan name and seat-price override', async () => {
    const db = makeDb({
      billing_teams: [team()],
      billing_plans: PLANS,
      billing_subscriptions: [],
    })
    const handler = createGetTeamMembersHandler(fakeUserService(), db as any)
    const res = await handler(ctx('owner1'), { teamId: 'team_acme' })
    expect(res.team).toMatchObject({
      _id: 'team_acme',
      planId: 'plan_growth',
      planName: 'Growth',
      seatPrice: 75,
      customSeatPrice: 75,
      seatCount: 2,
      ownerId: 'owner1',
    })
  })
})
