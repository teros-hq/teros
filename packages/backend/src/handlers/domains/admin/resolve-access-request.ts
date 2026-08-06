/**
 * admin.resolve-access-request — approve or deny a billing access request
 * (decision #10). Admin/super only.
 *
 * approve:
 *   - 'boost':   grant the hours on the user's CURRENT active period by creating
 *     a BillingHourBoost (idempotent by accessRequestId). The effective limit
 *     rises immediately (getActiveBoostHours sums active boosts), unblocking the
 *     user without a plan change.
 *   - 'upgrade': apply an immediate plan change via the shared
 *     changeUserPlanImmediate helper (same flow as the admin panel, decision #6).
 * deny: record the resolution; no grant.
 *
 * Either way the user is notified in-app. Returns DATA, never UI strings.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { UserService } from '../../../auth/user-service'
import {
  getActiveSubscription,
  getBillingAccessRequestsCollection,
  insertHourBoost,
  MAX_BOOST_HOURS,
} from '../../../models/billing.js'
import type { BillingEventPublisher } from '../../../services/agent-hours-tracker.js'
import { changeUserPlanImmediate } from '../../../services/billing-subscription-ops.js'
import type { StripePaymentService } from '../../../services/stripe-payment-service.js'

interface ResolveAccessRequestData {
  requestId?: string
  action?: 'approve' | 'deny'
  /** Admin override of the granted hours for a boost (defaults to requestedHours). */
  grantedHours?: number
  note?: string
}

const MAX_NOTE_LEN = 1000

export function createResolveAccessRequestHandler(
  userService: UserService,
  db: Db,
  pubsub: BillingEventPublisher | null,
  stripe?: StripePaymentService | null,
) {
  return async function resolveAccessRequest(ctx: WsHandlerContext, rawData: unknown) {
    const caller = await userService.getByUserId(ctx.userId)
    if (caller?.role !== 'admin' && caller?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin privileges required')
    }

    const data = (rawData ?? {}) as ResolveAccessRequestData
    if (typeof data.requestId !== 'string' || data.requestId.trim() === '') {
      throw new HandlerError('MISSING_FIELDS', 'requestId is required')
    }
    if (data.action !== 'approve' && data.action !== 'deny') {
      throw new HandlerError('INVALID_INPUT', "action must be 'approve' or 'deny'")
    }
    const note =
      typeof data.note === 'string' && data.note.trim() !== ''
        ? data.note.trim().slice(0, MAX_NOTE_LEN)
        : null

    const requestsCol = getBillingAccessRequestsCollection(db)
    const request = await requestsCol.findOne({ _id: data.requestId })
    if (!request) {
      throw new HandlerError('NOT_FOUND', 'Access request not found')
    }
    if (request.status !== 'pending') {
      throw new HandlerError('ALREADY_RESOLVED', `Request is already ${request.status}`)
    }

    const now = new Date()

    // ── Deny ─────────────────────────────────────────────────────────────────
    if (data.action === 'deny') {
      const res = await requestsCol.updateOne(
        { _id: request._id, status: 'pending' },
        { $set: { status: 'denied', resolvedBy: ctx.userId, resolvedAt: now, resolutionNote: note, updatedAt: now } },
      )
      if (res.matchedCount === 0) {
        throw new HandlerError('ALREADY_RESOLVED', 'Request was resolved concurrently')
      }
      pubsub?.broadcastToUser(request.userId, {
        type: 'billing.access-denied',
        requestId: request._id,
        requestType: request.type,
        note,
      })
      return { requestId: request._id, status: 'denied' }
    }

    // ── Approve: resolve against the user's CURRENT active sub (it may have
    // changed since the request was filed). ─────────────────────────────────
    const active = await getActiveSubscription(db, request.userId)
    if (!active) {
      throw new HandlerError('NO_SUBSCRIPTION', 'User has no active subscription to grant against')
    }

    if (request.type === 'boost') {
      const hours = data.grantedHours ?? request.requestedHours
      if (typeof hours !== 'number' || !Number.isFinite(hours) || !Number.isInteger(hours) || hours <= 0 || hours > MAX_BOOST_HOURS) {
        throw new HandlerError('INVALID_INPUT', `grantedHours must be an integer in [1, ${MAX_BOOST_HOURS}]`)
      }

      // Boost-first (idempotent by accessRequestId): a re-approval after a crash
      // hits the unique index, falls through, and still marks the request done.
      const { boostId } = await insertHourBoost(db, {
        _id: crypto.randomUUID(),
        userId: request.userId,
        subscriptionId: active._id,
        hours,
        periodStart: active.currentPeriodStart,
        periodEnd: active.currentPeriodEnd,
        grantedBy: ctx.userId,
        accessRequestId: request._id,
        source: 'access_request',
        note: null,
        createdAt: now,
      })

      await requestsCol.updateOne(
        { _id: request._id, status: 'pending' },
        { $set: { status: 'approved', resolvedBy: ctx.userId, resolvedAt: now, resolutionNote: note, boostId, updatedAt: now } },
      )

      pubsub?.broadcastToUser(request.userId, {
        type: 'billing.access-granted',
        requestId: request._id,
        requestType: 'boost',
        grantedHours: hours,
      })
      return { requestId: request._id, status: 'approved', type: 'boost', grantedHours: hours, boostId }
    }

    // type === 'upgrade'
    if (!request.requestedPlanId) {
      throw new HandlerError('INVALID_INPUT', 'Upgrade request has no requestedPlanId')
    }
    // Claim-first: mark approved with the pending guard so the non-idempotent
    // plan change runs at most once even under a concurrent approval.
    const claim = await requestsCol.updateOne(
      { _id: request._id, status: 'pending' },
      { $set: { status: 'approved', resolvedBy: ctx.userId, resolvedAt: now, resolutionNote: note, updatedAt: now } },
    )
    if (claim.matchedCount === 0) {
      throw new HandlerError('ALREADY_RESOLVED', 'Request was resolved concurrently')
    }
    // Admin-approved grant does NOT auto-charge (TER-626): no stripe → no
    // best-effort balance transaction.
    const newSubId = await changeUserPlanImmediate(db, active, request.requestedPlanId, now, {})

    pubsub?.broadcastToUser(request.userId, {
      type: 'billing.access-granted',
      requestId: request._id,
      requestType: 'upgrade',
      planId: request.requestedPlanId,
    })
    return { requestId: request._id, status: 'approved', type: 'upgrade', planId: request.requestedPlanId, newSubId }
  }
}
