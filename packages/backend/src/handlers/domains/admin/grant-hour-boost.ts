/**
 * admin.grant-hour-boost — an admin grants a user extra agent-hours for the
 * CURRENT billing period only (TER-686). Admin/super only.
 *
 * This is the direct counterpart of resolve-access-request's boost approval: it
 * grants without a prior user request. It creates a BillingHourBoost tied to the
 * user's active period (copies currentPeriodStart/End), so the extra hours raise
 * the effective limit immediately (getActiveBoostHours) and EXPIRE at period
 * rollover (billing-reset-cron) — it never touches customAgentHoursLimit (the
 * PERMANENT override lives in update-billing-subscription).
 *
 * Idempotent by PK: `admin-grant:<userId>:<idempotencyKey>` — a double-click /
 * retry with the same key resolves to the existing boost, never double-granting.
 * Returns DATA, never UI strings.
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import type { UserService } from "../../../auth/user-service"
import {
  getActiveSubscription,
  getBillingPlansCollection,
  getEffectiveLimit,
  insertHourBoost,
  MAX_BOOST_HOURS,
} from "../../../models/billing.js"
import type { BillingEventPublisher } from "../../../services/agent-hours-tracker.js"
import { HandlerError } from "../../../ws-framework/WsRouter"

interface GrantHourBoostData {
  targetUserId?: string
  hours?: number
  note?: string
  /** Client-generated nonce for idempotency (one per grant attempt). */
  idempotencyKey?: string
}

const MAX_NOTE_LEN = 1000
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/

export function createGrantHourBoostHandler(
  userService: UserService,
  db: Db,
  pubsub: BillingEventPublisher | null,
) {
  return async function grantHourBoost(ctx: WsHandlerContext, rawData: unknown) {
    const caller = await userService.getByUserId(ctx.userId)
    if (caller?.role !== "admin" && caller?.role !== "super") {
      throw new HandlerError("FORBIDDEN", "Admin privileges required")
    }

    const data = (rawData ?? {}) as GrantHourBoostData
    if (typeof data.targetUserId !== "string" || data.targetUserId.trim() === "") {
      throw new HandlerError("MISSING_FIELDS", "targetUserId is required")
    }
    const targetUserId = data.targetUserId
    const hours = data.hours
    if (
      typeof hours !== "number" ||
      !Number.isFinite(hours) ||
      !Number.isInteger(hours) ||
      hours <= 0 ||
      hours > MAX_BOOST_HOURS
    ) {
      throw new HandlerError("INVALID_INPUT", `hours must be an integer in [1, ${MAX_BOOST_HOURS}]`)
    }
    if (typeof data.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_RE.test(data.idempotencyKey)) {
      throw new HandlerError(
        "INVALID_INPUT",
        "idempotencyKey is required: 1-128 chars of [A-Za-z0-9_-]",
      )
    }
    const note =
      typeof data.note === "string" && data.note.trim() !== ""
        ? data.note.trim().slice(0, MAX_NOTE_LEN)
        : null

    // Resolve against the user's CURRENT active sub — the boost is pinned to its
    // period window so the reset-cron expires it at rollover.
    const active = await getActiveSubscription(db, targetUserId)
    if (!active) {
      throw new HandlerError("NO_SUBSCRIPTION", "User has no active subscription to grant against")
    }
    const plan = await getBillingPlansCollection(db).findOne({ _id: active.planId })
    if (!plan) {
      throw new HandlerError("NOT_FOUND", "Subscription plan not found")
    }
    // A boost only raises the effective limit on a metered Teros plan (the gate
    // short-circuits otherwise) — refuse a no-op grant, same rule as purchase-boost.
    if (!plan.features.terosModel || getEffectiveLimit(active, plan) <= 0) {
      throw new HandlerError(
        "GRANT_NOT_APPLICABLE",
        "This plan does not meter agent-hours; a boost would add nothing.",
      )
    }

    const now = new Date()
    const { boostId, deduped } = await insertHourBoost(db, {
      _id: `admin-grant:${targetUserId}:${data.idempotencyKey}`,
      userId: targetUserId,
      subscriptionId: active._id,
      hours,
      periodStart: active.currentPeriodStart,
      periodEnd: active.currentPeriodEnd,
      grantedBy: ctx.userId,
      accessRequestId: null,
      source: "admin_grant",
      note,
      createdAt: now,
    })

    pubsub?.broadcastToUser(targetUserId, {
      type: "billing.access-granted",
      requestType: "boost",
      grantedHours: hours,
      source: "admin_grant",
    })

    return {
      targetUserId,
      boostId,
      hours,
      deduped,
      periodEnd: active.currentPeriodEnd.toISOString(),
    }
  }
}
