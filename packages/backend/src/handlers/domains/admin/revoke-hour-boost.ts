/**
 * admin.revoke-hour-boost — an admin revokes an active hour boost (TER-686).
 * Admin/super only.
 *
 * Flips status active → revoked; the effective limit and the gate already respect
 * it (getActiveBoostHours only sums status:'active'), so the user's period limit
 * drops back immediately. Scoped to (boostId, userId) so an admin can only revoke
 * a boost that belongs to the target user. Records revokedBy/revokedAt for the
 * audit trail. Returns DATA, never UI strings.
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import type { UserService } from "../../../auth/user-service"
import { getBillingHourBoostsCollection } from "../../../models/billing.js"
import type { BillingEventPublisher } from "../../../services/agent-hours-tracker.js"
import { HandlerError } from "../../../ws-framework/WsRouter"

interface RevokeHourBoostData {
  targetUserId?: string
  boostId?: string
}

export function createRevokeHourBoostHandler(
  userService: UserService,
  db: Db,
  pubsub: BillingEventPublisher | null,
) {
  return async function revokeHourBoost(ctx: WsHandlerContext, rawData: unknown) {
    const caller = await userService.getByUserId(ctx.userId)
    if (caller?.role !== "admin" && caller?.role !== "super") {
      throw new HandlerError("FORBIDDEN", "Admin privileges required")
    }

    const data = (rawData ?? {}) as RevokeHourBoostData
    if (typeof data.targetUserId !== "string" || data.targetUserId.trim() === "") {
      throw new HandlerError("MISSING_FIELDS", "targetUserId is required")
    }
    if (typeof data.boostId !== "string" || data.boostId.trim() === "") {
      throw new HandlerError("MISSING_FIELDS", "boostId is required")
    }

    const now = new Date()
    // Only an ACTIVE boost belonging to the target user can be revoked. A second
    // revoke (already revoked/expired) matches nothing → NOT_FOUND, so the op is
    // safe to retry.
    const updated = await getBillingHourBoostsCollection(db).findOneAndUpdate(
      { _id: data.boostId, userId: data.targetUserId, status: "active" },
      { $set: { status: "revoked", revokedBy: ctx.userId, revokedAt: now } },
      { returnDocument: "after" },
    )
    if (!updated) {
      throw new HandlerError("NOT_FOUND", "No active boost with that id for this user")
    }

    pubsub?.broadcastToUser(data.targetUserId, {
      type: "billing.boost-revoked",
      boostId: data.boostId,
      hours: updated.hours,
    })

    return {
      targetUserId: data.targetUserId,
      boostId: data.boostId,
      status: "revoked",
      hours: updated.hours,
    }
  }
}
