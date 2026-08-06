/**
 * FASE 6c/6d — request-access + admin resolve handlers.
 *
 * Covers the user-facing request flow, the admin queue listing, and approval
 * (boost / upgrade) / denial, with faithful boundaries: the InMemoryDb enforces
 * _id uniqueness, and a wrapper enforces the partial unique index that caps a
 * user to one pending request per type. Each assertion checks the exact payload
 * / persisted state so a mutation in the handler turns it red.
 */

import { describe, expect, it } from 'bun:test'
import { MongoServerError } from 'mongodb'
import { InMemoryDb } from './_stripe-test-helpers'
import { createRequestAccessHandler } from '../../src/handlers/domains/billing/request-access'
import { createListAccessRequestsHandler } from '../../src/handlers/domains/admin/list-access-requests'
import { createResolveAccessRequestHandler } from '../../src/handlers/domains/admin/resolve-access-request'

const PERIOD_START = new Date('2026-06-01T00:00:00Z')
const PERIOD_END = new Date('2026-07-01T00:00:00Z')

function makeDb(seed: Record<string, any[]>) {
  const db = new InMemoryDb()
  for (const [col, docs] of Object.entries(seed)) db.seed(col, docs)
  // Enforce the partial unique index (userId, type) where status:'pending'.
  const access = db.collection('billing_access_requests')
  const origInsert = access.insertOne.bind(access)
  access.insertOne = async (doc: any) => {
    if (
      doc.status === 'pending' &&
      access.docs.some((d) => d.userId === doc.userId && d.type === doc.type && d.status === 'pending')
    ) {
      const e = new MongoServerError({ message: 'E11000 duplicate key' })
      ;(e as any).code = 11000
      throw e
    }
    return origInsert(doc)
  }
  // Enforce the unique index on billing_hour_boosts.accessRequestId.
  const boostsCol = db.collection('billing_hour_boosts')
  const origBoostInsert = boostsCol.insertOne.bind(boostsCol)
  boostsCol.insertOne = async (doc: any) => {
    if (doc.accessRequestId !== undefined && boostsCol.docs.some((b) => b.accessRequestId === doc.accessRequestId)) {
      const e = new MongoServerError({ message: 'E11000 duplicate key' })
      ;(e as any).code = 11000
      throw e
    }
    return origBoostInsert(doc)
  }
  return db
}

const USERS = [
  { userId: 'u', role: 'user', profile: { displayName: 'Nora', email: 'nora@x.io' } },
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

const PLANS = [
  // Faithful to the catalogue: a requestable upgrade target is a PUBLIC plan
  // (request-access filters isPublic, like change-plan / preview-plan-change).
  { _id: 'plan_pro', name: 'pro', displayName: 'Pro', price: 89, currency: 'EUR', agentHoursLimit: 80, isPublic: true },
  { _id: 'plan_max', name: 'max', displayName: 'Max', price: 179, currency: 'EUR', agentHoursLimit: 200, isPublic: true },
]

const ctx = (userId: string) => ({ userId }) as any

// ============================================================================
// billing.request-access
// ============================================================================

describe('billing.request-access', () => {
  it('creates a pending boost request and notifies every admin with the exact payload', async () => {
    const db = makeDb({ billing_subscriptions: [activeSub()], billing_plans: PLANS })
    const spy = makeSpy()
    const handler = createRequestAccessHandler(db as any, fakeUserService(), spy)

    const res = await handler(ctx('u'), { type: 'boost', requestedHours: 20, reason: '  need more  ' })

    expect(res.request).toMatchObject({ type: 'boost', requestedHours: 20, requestedPlanId: null, reason: 'need more', status: 'pending' })
    // Persisted exactly once.
    const stored = db.collection('billing_access_requests').docs
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ userId: 'u', subscriptionId: 'sub1', type: 'boost', requestedHours: 20, status: 'pending' })
    // Broadcast to admin1 + super1 (not the requester).
    expect(spy.events.map((e) => e.userId).sort()).toEqual(['admin1', 'super1'])
    expect(spy.events[0].event).toEqual({
      type: 'billing.access-requested',
      requestId: stored[0]._id,
      userId: 'u',
      userName: 'Nora',
      requestType: 'boost',
      requestedHours: 20,
      requestedPlanId: null,
      reason: 'need more',
      createdAt: stored[0].createdAt.toISOString(),
    })
  })

  it('creates an upgrade request when the target plan exists', async () => {
    const db = makeDb({ billing_subscriptions: [activeSub()], billing_plans: PLANS })
    const handler = createRequestAccessHandler(db as any, fakeUserService(), makeSpy())
    const res = await handler(ctx('u'), { type: 'upgrade', requestedPlanId: 'plan_max' })
    expect(res.request).toMatchObject({ type: 'upgrade', requestedPlanId: 'plan_max', requestedHours: null })
  })

  it('rejects an unknown type', async () => {
    const db = makeDb({ billing_subscriptions: [activeSub()] })
    const handler = createRequestAccessHandler(db as any, fakeUserService(), makeSpy())
    await expect(handler(ctx('u'), { type: 'whatever' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('rejects a boost with non-positive / non-integer hours', async () => {
    const db = makeDb({ billing_subscriptions: [activeSub()] })
    const handler = createRequestAccessHandler(db as any, fakeUserService(), makeSpy())
    await expect(handler(ctx('u'), { type: 'boost', requestedHours: 0 })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(handler(ctx('u'), { type: 'boost', requestedHours: 5.5 })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('rejects an upgrade to a non-existent plan', async () => {
    const db = makeDb({ billing_subscriptions: [activeSub()], billing_plans: PLANS })
    const handler = createRequestAccessHandler(db as any, fakeUserService(), makeSpy())
    await expect(handler(ctx('u'), { type: 'upgrade', requestedPlanId: 'plan_ghost' })).rejects.toMatchObject({ code: 'INVALID_PLAN' })
  })

  it('rejects when the user has no active subscription', async () => {
    const db = makeDb({ billing_plans: PLANS })
    const handler = createRequestAccessHandler(db as any, fakeUserService(), makeSpy())
    await expect(handler(ctx('u'), { type: 'boost', requestedHours: 10 })).rejects.toMatchObject({ code: 'NO_SUBSCRIPTION' })
  })

  it('rejects a second pending request of the same type (partial unique index)', async () => {
    const db = makeDb({ billing_subscriptions: [activeSub()], billing_plans: PLANS })
    const handler = createRequestAccessHandler(db as any, fakeUserService(), makeSpy())
    await handler(ctx('u'), { type: 'boost', requestedHours: 10 })
    await expect(handler(ctx('u'), { type: 'boost', requestedHours: 5 })).rejects.toMatchObject({ code: 'REQUEST_PENDING' })
  })
})

// ============================================================================
// admin.list-access-requests
// ============================================================================

describe('admin.list-access-requests', () => {
  function seedRequests() {
    return [
      { _id: 'req1', userId: 'u', subscriptionId: 'sub1', type: 'boost', requestedHours: 20, requestedPlanId: null, reason: 'x', status: 'pending', resolvedBy: null, resolvedAt: null, resolutionNote: null, boostId: null, createdAt: new Date('2026-06-10Z'), updatedAt: new Date('2026-06-10Z') },
      { _id: 'req2', userId: 'u', subscriptionId: 'sub1', type: 'upgrade', requestedHours: null, requestedPlanId: 'plan_max', reason: null, status: 'approved', resolvedBy: 'admin1', resolvedAt: new Date('2026-06-11Z'), resolutionNote: 'ok', boostId: null, createdAt: new Date('2026-06-09Z'), updatedAt: new Date('2026-06-11Z') },
    ]
  }

  it('rejects a non-admin caller', async () => {
    const db = makeDb({ billing_access_requests: seedRequests() })
    const handler = createListAccessRequestsHandler(fakeUserService(), db as any)
    await expect(handler(ctx('u'), {})).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('lists pending by default and resolves user + plan names', async () => {
    const db = makeDb({ billing_access_requests: seedRequests(), billing_plans: PLANS })
    const handler = createListAccessRequestsHandler(fakeUserService(), db as any)
    const res = await handler(ctx('admin1'), {})
    expect(res.status).toBe('pending')
    expect(res.requests).toHaveLength(1)
    expect(res.requests[0]).toMatchObject({ _id: 'req1', userName: 'Nora', userEmail: 'nora@x.io', type: 'boost', requestedHours: 20 })
  })

  it('filters by status and resolves the requested plan name', async () => {
    const db = makeDb({ billing_access_requests: seedRequests(), billing_plans: PLANS })
    const handler = createListAccessRequestsHandler(fakeUserService(), db as any)
    const res = await handler(ctx('admin1'), { status: 'approved' })
    expect(res.requests).toHaveLength(1)
    expect(res.requests[0]).toMatchObject({ _id: 'req2', requestedPlanName: 'Max' })
  })
})

// ============================================================================
// admin.list-access-requests — requester billing context (TER-596 A1)
// ============================================================================

describe('admin.list-access-requests — requester context (A1)', () => {
  // A wide-open window so getActiveBoostHours (which reads the handler's live
  // `new Date()`) always matches, independent of the test clock.
  const FOREVER_START = new Date('2000-01-01T00:00:00Z')
  const FOREVER_END = new Date('2100-01-01T00:00:00Z')

  it('attaches the requester current plan, usage and estimated boost cost', async () => {
    // Active Pro sub, 70/80h used; boost request of 20h; €3/h boost price.
    const db = makeDb({
      billing_access_requests: [pendingBoostReq({ requestedHours: 20 })],
      billing_subscriptions: [activeSub({ agentHoursUsed: 70 })],
      billing_plans: PLANS,
    })
    const handler = createListAccessRequestsHandler(fakeUserService(), db as any, {
      boostHourPrice: 3,
      boostCurrency: 'EUR',
    })
    const res = await handler(ctx('admin1'), {})
    expect(res.requests).toHaveLength(1)
    expect(res.requests[0]).toMatchObject({
      currentPlanId: 'plan_pro',
      currentPlanName: 'Pro',
      agentHoursUsed: 70,
      agentHoursLimit: 80,
      usagePct: 88, // 70/80 = 87.5 → rounded (a floor mutation would give 87)
      estimatedCost: 60, // 20h × €3
      estimatedCostCurrency: 'EUR',
    })
  })

  it('omits estimatedCost when no boost price is configured', async () => {
    const db = makeDb({
      billing_access_requests: [pendingBoostReq({ requestedHours: 20 })],
      billing_subscriptions: [activeSub()],
      billing_plans: PLANS,
    })
    const handler = createListAccessRequestsHandler(fakeUserService(), db as any, {
      boostHourPrice: null,
      boostCurrency: 'EUR',
    })
    const res = await handler(ctx('admin1'), {})
    // MUST BITE: surfacing a "€" cost with no price would mislead the admin.
    expect(res.requests[0].estimatedCost).toBeNull()
  })

  it('never estimates a cost for an upgrade request (only boosts have one)', async () => {
    const db = makeDb({
      billing_access_requests: [pendingUpgradeReq()],
      billing_subscriptions: [activeSub()],
      billing_plans: PLANS,
    })
    const handler = createListAccessRequestsHandler(fakeUserService(), db as any, {
      boostHourPrice: 3,
      boostCurrency: 'EUR',
    })
    const res = await handler(ctx('admin1'), {})
    expect(res.requests[0]).toMatchObject({ type: 'upgrade', estimatedCost: null, currentPlanName: 'Pro' })
  })

  it('includes active boost hours in the effective limit (and the %)', async () => {
    // 70h used, Pro 80h base + a 40h active boost → effective 120h.
    const db = makeDb({
      billing_access_requests: [pendingBoostReq({ requestedHours: 20 })],
      billing_subscriptions: [activeSub({ agentHoursUsed: 70 })],
      billing_plans: PLANS,
      billing_hour_boosts: [
        { _id: 'b1', userId: 'u', subscriptionId: 'sub1', hours: 40, periodStart: FOREVER_START, periodEnd: FOREVER_END, status: 'active', grantedBy: 'admin1', accessRequestId: 'old', createdAt: FOREVER_START },
      ],
    })
    const handler = createListAccessRequestsHandler(fakeUserService(), db as any, {
      boostHourPrice: 3,
      boostCurrency: 'EUR',
    })
    const res = await handler(ctx('admin1'), {})
    // MUST BITE: ignoring the boost would report 80h / 88% instead of 120h / 58%.
    expect(res.requests[0]).toMatchObject({ agentHoursLimit: 120, usagePct: 58 })
  })

  it('returns null context when the requester has no active subscription', async () => {
    const db = makeDb({
      billing_access_requests: [pendingBoostReq({ requestedHours: 20 })],
      billing_plans: PLANS,
    })
    const handler = createListAccessRequestsHandler(fakeUserService(), db as any, {
      boostHourPrice: 3,
      boostCurrency: 'EUR',
    })
    const res = await handler(ctx('admin1'), {})
    expect(res.requests[0]).toMatchObject({
      currentPlanId: null,
      currentPlanName: null,
      agentHoursUsed: null,
      agentHoursLimit: null,
      usagePct: null,
      estimatedCost: 60, // the request value is independent of the current sub
    })
  })
})

// ============================================================================
// admin.resolve-access-request
// ============================================================================

function pendingBoostReq(over: Record<string, any> = {}) {
  return {
    _id: 'req1', userId: 'u', subscriptionId: 'sub1', type: 'boost', requestedHours: 20,
    requestedPlanId: null, reason: 'x', status: 'pending', resolvedBy: null, resolvedAt: null,
    resolutionNote: null, boostId: null, createdAt: PERIOD_START, updatedAt: PERIOD_START, ...over,
  }
}
function pendingUpgradeReq(over: Record<string, any> = {}) {
  return { ...pendingBoostReq(), _id: 'req2', type: 'upgrade', requestedHours: null, requestedPlanId: 'plan_max', ...over }
}

describe('admin.resolve-access-request', () => {
  it('rejects a non-admin caller', async () => {
    const db = makeDb({ billing_access_requests: [pendingBoostReq()] })
    const h = createResolveAccessRequestHandler(fakeUserService(), db as any, makeSpy(), null)
    await expect(h(ctx('u'), { requestId: 'req1', action: 'approve' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('404s an unknown request', async () => {
    const db = makeDb({ billing_access_requests: [] })
    const h = createResolveAccessRequestHandler(fakeUserService(), db as any, makeSpy(), null)
    await expect(h(ctx('admin1'), { requestId: 'nope', action: 'deny' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('approves a boost: creates the boost on the active period, marks approved, notifies the user', async () => {
    const db = makeDb({ billing_access_requests: [pendingBoostReq()], billing_subscriptions: [activeSub()] })
    const spy = makeSpy()
    const h = createResolveAccessRequestHandler(fakeUserService(), db as any, spy, null)

    const res = await h(ctx('admin1'), { requestId: 'req1', action: 'approve' })

    expect(res).toMatchObject({ requestId: 'req1', status: 'approved', type: 'boost', grantedHours: 20 })
    const boosts = db.collection('billing_hour_boosts').docs
    expect(boosts).toHaveLength(1)
    expect(boosts[0]).toMatchObject({
      userId: 'u', subscriptionId: 'sub1', hours: 20, status: 'active',
      grantedBy: 'admin1', accessRequestId: 'req1', periodStart: PERIOD_START, periodEnd: PERIOD_END,
    })
    const req = db.collection('billing_access_requests').docs[0]
    expect(req).toMatchObject({ status: 'approved', resolvedBy: 'admin1', boostId: boosts[0]._id })
    expect(spy.events).toEqual([{ userId: 'u', event: { type: 'billing.access-granted', requestId: 'req1', requestType: 'boost', grantedHours: 20 } }])
  })

  it('honors a grantedHours override on a boost approval', async () => {
    const db = makeDb({ billing_access_requests: [pendingBoostReq()], billing_subscriptions: [activeSub()] })
    const h = createResolveAccessRequestHandler(fakeUserService(), db as any, makeSpy(), null)
    const res = await h(ctx('admin1'), { requestId: 'req1', action: 'approve', grantedHours: 7 })
    expect(res).toMatchObject({ grantedHours: 7 })
    expect(db.collection('billing_hour_boosts').docs[0].hours).toBe(7)
  })

  it('approves an upgrade: closes the active sub and opens the new plan day+1', async () => {
    const db = makeDb({ billing_access_requests: [pendingUpgradeReq()], billing_subscriptions: [activeSub()], billing_plans: PLANS })
    const spy = makeSpy()
    const h = createResolveAccessRequestHandler(fakeUserService(), db as any, spy, null)

    const res = await h(ctx('admin1'), { requestId: 'req2', action: 'approve' })

    expect(res).toMatchObject({ status: 'approved', type: 'upgrade', planId: 'plan_max' })
    const subs = db.collection('billing_subscriptions').docs
    const ended = subs.find((s) => s._id === 'sub1')
    const fresh = subs.find((s) => s._id === res.newSubId)
    expect(ended.status).toBe('ended')
    expect(fresh).toMatchObject({ planId: 'plan_max', status: 'active' })
    // The request is claimed approved (the guard that makes the non-idempotent
    // plan change run at most once).
    expect(db.collection('billing_access_requests').docs[0]).toMatchObject({ status: 'approved', resolvedBy: 'admin1' })
    expect(spy.events[0].event).toMatchObject({ type: 'billing.access-granted', requestType: 'upgrade', planId: 'plan_max' })
  })

  it('denies a request: records the note and notifies the user, no grant', async () => {
    const db = makeDb({ billing_access_requests: [pendingBoostReq()], billing_subscriptions: [activeSub()] })
    const spy = makeSpy()
    const h = createResolveAccessRequestHandler(fakeUserService(), db as any, spy, null)
    const res = await h(ctx('admin1'), { requestId: 'req1', action: 'deny', note: 'no budget' })
    expect(res).toEqual({ requestId: 'req1', status: 'denied' })
    expect(db.collection('billing_hour_boosts').docs).toHaveLength(0)
    expect(db.collection('billing_access_requests').docs[0]).toMatchObject({ status: 'denied', resolutionNote: 'no budget' })
    expect(spy.events).toEqual([{ userId: 'u', event: { type: 'billing.access-denied', requestId: 'req1', requestType: 'boost', note: 'no budget' } }])
  })

  it('rejects resolving an already-resolved request', async () => {
    const db = makeDb({ billing_access_requests: [pendingBoostReq({ status: 'approved' })], billing_subscriptions: [activeSub()] })
    const h = createResolveAccessRequestHandler(fakeUserService(), db as any, makeSpy(), null)
    await expect(h(ctx('admin1'), { requestId: 'req1', action: 'approve' })).rejects.toMatchObject({ code: 'ALREADY_RESOLVED' })
  })

  it('a re-approval after the boost exists is idempotent (no second boost)', async () => {
    // Simulate a crash recovery: boost already created, request still pending.
    const db = makeDb({
      billing_access_requests: [pendingBoostReq()],
      billing_subscriptions: [activeSub()],
      billing_hour_boosts: [{ _id: 'b-existing', userId: 'u', subscriptionId: 'sub1', hours: 20, periodStart: PERIOD_START, periodEnd: PERIOD_END, status: 'active', grantedBy: 'admin1', accessRequestId: 'req1', createdAt: PERIOD_START }],
    })
    const h = createResolveAccessRequestHandler(fakeUserService(), db as any, makeSpy(), null)
    const res = await h(ctx('admin1'), { requestId: 'req1', action: 'approve' })
    expect(db.collection('billing_hour_boosts').docs).toHaveLength(1)
    expect(res).toMatchObject({ status: 'approved', boostId: 'b-existing' })
  })
})
