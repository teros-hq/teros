/**
 * admin-api.channel-usage — Per-conversation token usage (admin only)
 *
 * Actions:
 *   admin-api.channel-token-budget → token usage of one conversation
 *
 * Context (Pablo, 2026-10-30): the "View token usage" option in the
 * conversation menu used to be fed by two user-facing channels —
 * `channel.get-messages` (tokenBudget field) and the `token_budget`
 * broadcast — so any member of a conversation could read its token
 * usage. Decision: the data is admin-only now. It lives behind this
 * admin-api action, guarded by requireAdmin (users.role ∈ admin|super),
 * same guard as admin-api.system-active-sessions.
 *
 * "Admin" criterion (documented): users.role === 'admin' | 'super' —
 * the platform-wide role from the admin-api domain. Workspace owners
 * are NOT included (deliberate: not expanding scope without Pablo's
 * explicit confirmation).
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import type { UsageService } from "../../../services/usage-service"
import { HandlerError } from "../../../ws-framework/WsRouter"

async function requireAdmin(db: Db, userId: string): Promise<void> {
  const user = await db.collection("users").findOne({ userId })
  if (user?.role !== "admin" && user?.role !== "super") {
    throw new HandlerError("FORBIDDEN", "Admin privileges required")
  }
}

/**
 * admin-api.channel-token-budget — token budget/usage of a conversation.
 *
 * Params: channelId (required, string).
 * Returns the same TokenBudget shape the chat header modal renders
 * (UsageService.calculateBudget), or `budget: null` when the channel
 * has no recorded usage yet. Non-admins get FORBIDDEN — no data.
 */
export function createChannelTokenBudgetHandler(db: Db, usageService: UsageService) {
  return async function channelTokenBudget(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)

    const data = (rawData && typeof rawData === "object" ? rawData : {}) as Record<string, unknown>
    // channelId flows into a Mongo lookup — coerce to a plain non-empty string
    // so an object can't smuggle in a query operator (NoSQL injection).
    const channelId = typeof data.channelId === "string" ? data.channelId.trim() : ""
    if (!channelId) {
      throw new HandlerError("VALIDATION_ERROR", "channelId is required")
    }

    const channel = await db.collection("channels").findOne({ channelId })
    if (!channel) {
      throw new HandlerError("NOT_FOUND", "Channel not found")
    }

    const budget = await usageService.calculateBudget(channelId)
    return {
      channelId,
      budget,
    }
  }
}
