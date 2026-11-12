/**
 * UserApi — Typed client for the user-api domain (user-api.*).
 *
 * Mirrors the backend handlers in
 * packages/backend/src/handlers/domains/user-api. Self-service usage queries:
 * the backend forces `userId = ctx.userId` on every action, so a user can
 * never read someone else's data — no scoping is possible from this side.
 */

import type { Transport } from "./transport/types"

/** Per-channel agent-hours for the current billing period (WS2). */
export interface ChannelAgentHours {
  /** SUM of billable session durations in this channel, ms (decision #29). */
  workMs: number
  /** Billable sessions counted in that channel this period. */
  sessions: number
}

/** Result of user-api.my-usage-channels-summary. */
export interface ChannelsSummaryView {
  /** channelId → its period usage. Channels with no billable use are absent. */
  channels: Record<string, ChannelAgentHours>
  /** Start of the billing period the numbers are scoped to (ISO string). */
  periodStart: string | null
}

export class UserApi {
  constructor(private readonly transport: Transport) {}

  /**
   * Batch per-channel agent-hours for the CURRENT billing period (WS2).
   *
   * One call serves the whole conversations list (or a board's linked
   * channels): the backend groups the caller's billable sessions by channel
   * in a single pass. Numbers line up with what the quota discounts — sum of
   * per-session durations (never union), same anti-phantom filters as
   * billing. Known lag: the tracker bills closed hour buckets, so this can
   * lead `agentHoursUsed` by up to ~1h; it self-corrects.
   */
  myUsageChannelsSummary(channelIds: string[]): Promise<ChannelsSummaryView> {
    return this.transport.request("user-api.my-usage-channels-summary", { channelIds })
  }
}
