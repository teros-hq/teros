/**
 * Value object identifying a rollup bucket within an hour.
 *
 * Encapsulates the four dimensions that partition `agent_usage_rollups_hourly`:
 *   (userId, agentId, provider, workspaceId)
 *
 * Before this VO, the rollup job concat'd a `${userId}|${agentId}|${provider}|${workspaceId}`
 * string and used it as a `Map<string, ...>` key — Data Clumps + Primitive
 * Obsession. The VO keeps the same string under the hood (so `Map` works
 * unchanged) but the call site now goes through a named factory + `toString`,
 * and the four dimensions can be recovered from a parsed key.
 *
 *
 */

import type { AgentUsageRollupHourly, AgentUsageSession } from "../types/database.js"

/**
 * Separator chosen because none of the four dimensions ever contain it
 * (provider is a fixed enum, IDs are `<prefix>_<hex16>`, workspaceId is
 * `work_<hex16>`). If you ever change one of those shapes, revisit.
 */
const SEPARATOR = "|"

export class AgentRollupGroupKey {
  private constructor(
    public readonly userId: string,
    public readonly agentId: string,
    public readonly provider: string,
    public readonly workspaceId: string,
  ) {}

  /**
   * Build the key from a session row. The session must have all four
   * dimensions populated (invariant of the AgentUsageSession schema).
   */
  static fromSession(session: AgentUsageSession): AgentRollupGroupKey {
    return new AgentRollupGroupKey(
      session.userId,
      session.agentId,
      session.provider,
      session.workspaceId,
    )
  }

  /**
   * Build the key from the embedded groupKey object stored in a rollup doc.
   * Useful for tests + the rebuild script.
   */
  static fromGroupKey(gk: AgentUsageRollupHourly["groupKey"]): AgentRollupGroupKey {
    return new AgentRollupGroupKey(gk.userId, gk.agentId, gk.provider, gk.workspaceId)
  }

  /**
   * Deterministic string representation usable as a `Map` key. Same shape
   * as the previous inline concat — preserves the on-the-wire format so
   * downstream consumers (none today) would not break.
   */
  toString(): string {
    return [this.userId, this.agentId, this.provider, this.workspaceId].join(SEPARATOR)
  }

  /**
   * Plain object suitable for the `groupKey` field of an
   * `AgentUsageRollupHourly` document. Cast to the union-typed provider
   * because the VO holds it as `string` (any LLMUsage.provider value
   * round-trips correctly).
   */
  toGroupKey(): AgentUsageRollupHourly["groupKey"] {
    return {
      userId: this.userId,
      agentId: this.agentId,
      provider: this.provider as AgentUsageRollupHourly["groupKey"]["provider"],
      workspaceId: this.workspaceId,
    }
  }

  equals(other: AgentRollupGroupKey): boolean {
    return (
      this.userId === other.userId &&
      this.agentId === other.agentId &&
      this.provider === other.provider &&
      this.workspaceId === other.workspaceId
    )
  }
}
