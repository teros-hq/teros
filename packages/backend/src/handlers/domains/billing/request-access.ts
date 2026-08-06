/**
 * billing.request-access — user asks to keep using the Teros model after hitting
 * (or nearing) their agent-hours limit (decision #10).
 *
 * Two kinds:
 *   - 'boost':   request `requestedHours` extra hours on the current period.
 *   - 'upgrade': request a move to `requestedPlanId`.
 *
 * Creates a pending billing_access_request and notifies admins in-app. The
 * partial unique index billing_access_req_one_pending caps the user to one
 * pending request per type, so the widget cannot spam the admin queue.
 *
 * Returns DATA (the created request), never UI strings — the frontend composes
 * the confirmation.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { UserService } from '../../../auth/user-service'
import { isMongoDuplicateKey } from '../../../lib/mongo-errors.js'
import {
  getActiveSubscription,
  getBillingAccessRequestsCollection,
  getBillingPlansCollection,
  getBillingTeamsCollection,
  type BillingAccessRequest,
} from '../../../models/billing.js'
import type { BillingEventPublisher } from '../../../services/agent-hours-tracker.js'
import { resolveAccessRequestRecipients } from './_access-routing.js'

interface RequestAccessData {
  type?: 'upgrade' | 'boost'
  requestedHours?: number
  requestedPlanId?: string
  reason?: string
}

const MAX_REASON_LEN = 1000
const MAX_BOOST_HOURS = 10000

export function createRequestAccessHandler(
  db: Db,
  userService: UserService,
  pubsub: BillingEventPublisher | null,
) {
  return async function requestAccess(ctx: WsHandlerContext, rawData: unknown) {
    const data = (rawData ?? {}) as RequestAccessData

    if (data.type !== 'upgrade' && data.type !== 'boost') {
      throw new HandlerError('INVALID_INPUT', "type must be 'upgrade' or 'boost'")
    }

    // Validate the type-specific payload at the boundary (JSON Schema can't).
    if (data.type === 'boost') {
      const h = data.requestedHours
      if (typeof h !== 'number' || !Number.isFinite(h) || !Number.isInteger(h) || h <= 0 || h > MAX_BOOST_HOURS) {
        throw new HandlerError(
          'INVALID_INPUT',
          `requestedHours must be an integer in [1, ${MAX_BOOST_HOURS}] for a boost request`,
        )
      }
    } else {
      if (typeof data.requestedPlanId !== 'string' || data.requestedPlanId.trim() === '') {
        throw new HandlerError('INVALID_INPUT', 'requestedPlanId is required for an upgrade request')
      }
      // Self-serve, like billing.change-plan / preview-plan-change: only PUBLIC
      // plans are requestable. A hidden tier (isPublic:false, e.g. plan_unlimited)
      // must not be visible nor self-nominable here either — only an admin grants it.
      const plan = await getBillingPlansCollection(db).findOne({ _id: data.requestedPlanId })
      if (!plan || !plan.isPublic) {
        throw new HandlerError('INVALID_PLAN', `Plan ${data.requestedPlanId} not found`)
      }
    }

    const reason =
      typeof data.reason === 'string' && data.reason.trim() !== ''
        ? data.reason.trim().slice(0, MAX_REASON_LEN)
        : null

    const active = await getActiveSubscription(db, ctx.userId)
    if (!active) {
      throw new HandlerError('NO_SUBSCRIPTION', 'No active subscription to request access for')
    }

    const now = new Date()
    const request: BillingAccessRequest = {
      _id: crypto.randomUUID(),
      userId: ctx.userId,
      subscriptionId: active._id,
      type: data.type,
      requestedHours: data.type === 'boost' ? (data.requestedHours as number) : null,
      requestedPlanId: data.type === 'upgrade' ? (data.requestedPlanId as string) : null,
      reason,
      status: 'pending',
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
      boostId: null,
      createdAt: now,
      updatedAt: now,
    }

    try {
      await getBillingAccessRequestsCollection(db).insertOne(request)
    } catch (err) {
      if (isMongoDuplicateKey(err)) {
        // The partial unique index rejected a second pending request of this type.
        throw new HandlerError(
          'REQUEST_PENDING',
          `You already have a pending ${data.type} request. Wait for an admin to resolve it.`,
        )
      }
      throw err
    }

    // Notify in-app (decision #10). Best-effort fan-out — a delivery failure must
    // not fail the request creation. Routing (TER-596 T1): if the requester is in
    // a team whose owner is a resolvable admin, only that owner (the "company
    // admin") is notified; otherwise every admin/super, as before. The requester
    // is always excluded. The recipient set is decided by
    // resolveAccessRequestRecipients — its single authority.
    if (pubsub) {
      const requester = await userService.getByUserId(ctx.userId)

      const team = active.teamId
        ? await getBillingTeamsCollection(db).findOne({ _id: active.teamId })
        : null
      // The owner must still be an admin/super to receive the routed push — the
      // Billing Requests UI is admin-gated, so a non-admin owner would strand the
      // request where nobody can act. A degraded/stale owner falls back to admins.
      const owner = team?.ownerId ? await userService.getByUserId(team.ownerId) : null
      const ownerIsResolvable = owner?.role === 'admin' || owner?.role === 'super'
      const admins = [
        ...(await userService.listUsers({ role: 'admin' })).users,
        ...(await userService.listUsers({ role: 'super' })).users,
      ]
      const recipientIds = resolveAccessRequestRecipients({
        requesterId: ctx.userId,
        teamOwnerId: team?.ownerId ?? null,
        ownerIsResolvable,
        adminUserIds: admins.map((a) => a.userId),
      })

      for (const recipientId of recipientIds) {
        pubsub.broadcastToUser(recipientId, {
          type: 'billing.access-requested',
          requestId: request._id,
          userId: request.userId,
          userName: requester?.profile?.displayName ?? null,
          requestType: request.type,
          requestedHours: request.requestedHours,
          requestedPlanId: request.requestedPlanId,
          reason: request.reason,
          createdAt: now.toISOString(),
        })
      }
    }

    return {
      request: {
        _id: request._id,
        type: request.type,
        requestedHours: request.requestedHours,
        requestedPlanId: request.requestedPlanId,
        reason: request.reason,
        status: request.status,
        createdAt: now.toISOString(),
      },
    }
  }
}
