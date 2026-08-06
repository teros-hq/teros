/**
 * TER-596 T1 — routing of the request-access notification.
 *
 * The high-risk change of meaning: this used to fan out to EVERY admin/super.
 * Now a team request goes only to the team owner (the future "company admin"),
 * with a fallback to all admins when there is no team / no resolvable owner.
 *
 * The pure helper resolveAccessRequestRecipients is the single authority; the
 * handler tests assert the broadcast audience end-to-end. A mutation that
 * notifies everyone again for a team request turns the "only the owner" tests
 * red.
 */

import { describe, expect, it } from 'bun:test'
import { InMemoryDb } from './_stripe-test-helpers'
import { resolveAccessRequestRecipients } from '../../src/handlers/domains/billing/_access-routing'
import { createRequestAccessHandler } from '../../src/handlers/domains/billing/request-access'

const PERIOD_START = new Date('2026-06-01T00:00:00Z')
const PERIOD_END = new Date('2026-07-01T00:00:00Z')

const ctx = (userId: string) => ({ userId }) as any

const PLANS = [
  { _id: 'plan_pro', name: 'pro', displayName: 'Pro', price: 89, currency: 'EUR', agentHoursLimit: 80 },
]

// owner1 owns the team AND is an admin — the realistic "company admin" (owners
// are created as admins). A degraded/non-admin owner falls back to all admins
// (dedicated test). Being a global admin, owner1 is also part of the fallback
// audience alongside admin1/super1.
const USERS = [
  { userId: 'u', role: 'user', profile: { displayName: 'Nora', email: 'nora@x.io' } },
  { userId: 'owner1', role: 'admin', profile: { displayName: 'Owner', email: 'o@x.io' } },
  { userId: 'admin1', role: 'admin', profile: { displayName: 'Admin One', email: 'a1@x.io' } },
  { userId: 'super1', role: 'super', profile: { displayName: 'Super', email: 's@x.io' } },
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

function makeSpy() {
  const events: Array<{ userId: string; event: any }> = []
  return {
    events,
    broadcastToUser(userId: string, event: Record<string, unknown>) {
      events.push({ userId, event })
    },
  }
}

function activeSub(over: Record<string, any> = {}) {
  return {
    _id: 'sub1',
    userId: 'u',
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
    terosProviderConfigId: null,
    teamId: null,
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
    planId: 'plan_pro',
    seatPrice: 89,
    customSeatPrice: null,
    seatCount: 1,
    maxSeats: 10,
    status: 'active',
    paymentMethod: 'manual',
    billingEmail: 'billing@acme.io',
    ownerId: 'owner1',
    memberIds: ['u'],
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

// ============================================================================
// Pure helper — the single authority for the recipient set
// ============================================================================

describe('resolveAccessRequestRecipients', () => {
  const admins = ['admin1', 'super1']

  it('routes ONLY to the owner when the team has a resolvable owner', () => {
    // MUST BITE: returning `adminUserIds` here (notify everyone again) fails.
    expect(
      resolveAccessRequestRecipients({ requesterId: 'u', teamOwnerId: 'owner1', ownerIsResolvable: true, adminUserIds: admins }),
    ).toEqual(['owner1'])
  })

  it('falls back to all admins when the owner no longer resolves (or is not admin)', () => {
    expect(
      resolveAccessRequestRecipients({ requesterId: 'u', teamOwnerId: 'ghost', ownerIsResolvable: false, adminUserIds: admins }),
    ).toEqual(['admin1', 'super1'])
  })

  it('falls back to all admins when the requester is not in a team', () => {
    expect(
      resolveAccessRequestRecipients({ requesterId: 'u', teamOwnerId: null, ownerIsResolvable: false, adminUserIds: admins }),
    ).toEqual(['admin1', 'super1'])
  })

  it('never notifies the requester — owner requesting for themselves gets nobody', () => {
    // MUST BITE: without the requester filter, this returns ['owner1'] (self-notify).
    expect(
      resolveAccessRequestRecipients({ requesterId: 'owner1', teamOwnerId: 'owner1', ownerIsResolvable: true, adminUserIds: admins }),
    ).toEqual([])
  })

  it('excludes the requester from the admin fallback audience', () => {
    // MUST BITE: without the filter, admin1 (the requester) gets their own badge.
    expect(
      resolveAccessRequestRecipients({ requesterId: 'admin1', teamOwnerId: null, ownerIsResolvable: false, adminUserIds: admins }),
    ).toEqual(['super1'])
  })
})

// ============================================================================
// Handler — broadcast audience end-to-end
// ============================================================================

describe('billing.request-access — notification routing', () => {
  it('notifies ONLY the team owner when the requester is in a team', async () => {
    const db = makeDb({
      billing_subscriptions: [activeSub({ teamId: 'team_acme' })],
      billing_plans: PLANS,
      billing_teams: [team()],
    })
    const spy = makeSpy()
    const handler = createRequestAccessHandler(db as any, fakeUserService(), spy)

    await handler(ctx('u'), { type: 'boost', requestedHours: 10 })

    // MUST BITE: the legacy fan-out would also push to admin1/super1.
    expect(spy.events.map((e) => e.userId)).toEqual(['owner1'])
    expect(spy.events[0].event).toMatchObject({
      type: 'billing.access-requested',
      userId: 'u',
      userName: 'Nora',
      requestType: 'boost',
      requestedHours: 10,
    })
  })

  it('falls back to every admin when the team owner no longer exists', async () => {
    const db = makeDb({
      billing_subscriptions: [activeSub({ teamId: 'team_acme' })],
      billing_plans: PLANS,
      billing_teams: [team({ ownerId: 'ghost' })],
    })
    const spy = makeSpy()
    const handler = createRequestAccessHandler(db as any, fakeUserService(), spy)

    await handler(ctx('u'), { type: 'boost', requestedHours: 10 })

    // Fallback is every admin/super — owner1 is itself a global admin, so it is
    // included alongside admin1/super1.
    expect(spy.events.map((e) => e.userId).sort()).toEqual(['admin1', 'owner1', 'super1'])
  })

  it('notifies every admin when the requester is not in a team (legacy)', async () => {
    const db = makeDb({
      billing_subscriptions: [activeSub({ teamId: null })],
      billing_plans: PLANS,
    })
    const spy = makeSpy()
    const handler = createRequestAccessHandler(db as any, fakeUserService(), spy)

    await handler(ctx('u'), { type: 'boost', requestedHours: 10 })

    expect(spy.events.map((e) => e.userId).sort()).toEqual(['admin1', 'owner1', 'super1'])
  })

  it('falls back to every admin when teamId points to a deleted team', async () => {
    const db = makeDb({
      billing_subscriptions: [activeSub({ teamId: 'team_gone' })],
      billing_plans: PLANS,
      billing_teams: [],
    })
    const spy = makeSpy()
    const handler = createRequestAccessHandler(db as any, fakeUserService(), spy)

    await handler(ctx('u'), { type: 'boost', requestedHours: 10 })

    expect(spy.events.map((e) => e.userId).sort()).toEqual(['admin1', 'owner1', 'super1'])
  })

  it('falls back to every admin when the team owner is no longer an admin (degraded)', async () => {
    const db = makeDb({
      billing_subscriptions: [activeSub({ teamId: 'team_acme' })],
      billing_plans: PLANS,
      billing_teams: [team()], // ownerId owner1
    })
    // owner1 was demoted to a plain user (e.g. via update-user-role).
    const demoted = USERS.map((u) => (u.userId === 'owner1' ? { ...u, role: 'user' } : u))
    const spy = makeSpy()
    const handler = createRequestAccessHandler(db as any, fakeUserService(demoted), spy)

    await handler(ctx('u'), { type: 'boost', requestedHours: 10 })

    // MUST BITE: without the admin role-check on the owner, owner1 (now non-admin)
    // would get the push and the request would be stranded — the Billing Requests
    // UI is admin-gated. Here the audience is the remaining admins.
    expect(spy.events.map((e) => e.userId).sort()).toEqual(['admin1', 'super1'])
  })

  it('never notifies the requester about their own request', async () => {
    const db = makeDb({
      billing_subscriptions: [activeSub({ userId: 'admin1', teamId: null })],
      billing_plans: PLANS,
    })
    const spy = makeSpy()
    const handler = createRequestAccessHandler(db as any, fakeUserService(), spy)

    // admin1 (a global admin) requests access for themselves → they must NOT be
    // notified of their own request.
    await handler(ctx('admin1'), { type: 'boost', requestedHours: 10 })

    // MUST BITE: without excluding the requester, admin1 appears in the audience.
    expect(spy.events.map((e) => e.userId).sort()).toEqual(['owner1', 'super1'])
  })
})
