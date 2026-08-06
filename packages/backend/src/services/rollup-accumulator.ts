/**
 * Per-agent rollup accumulator (Extract Class refactor R2.1).
 *
 * Encapsulates the state that aggregates a sequence of sessions into the
 * shape of an `agent_usage_rollups_hourly` document. Each session is fed
 * via `add(session, fraction, overlapMs)`; `toDoc(...)` produces the final
 * persistence shape.
 *
 * Splits split-proportional token math + status counters + modelMix from
 * the rollup job orchestration. The job now sees a typed object with a
 * single mutation entry point rather than a free-form record.
 *
 *
 */

import type { AgentUsageRollupHourly, AgentUsageSession } from "../types/database.js"
import { AgentRollupGroupKey } from "./agent-rollup-group-key.js"
import { accumulateSessionModelHealth } from "./model-health-aggregator.js"

export type RollupGroupKey = AgentUsageRollupHourly["groupKey"]
export type ModelMix = AgentUsageRollupHourly["modelMix"]
export type ModelMixEntry = ModelMix[string]
export type ModelHealth = NonNullable<AgentUsageRollupHourly["modelHealth"]>

export class RollupAccumulator {
  private modelMix: ModelMix = {}
  private modelHealth: ModelHealth = {}
  private sessionCount = 0
  private completedCount = 0
  private erroredCount = 0
  private timedOutCount = 0
  private abortedCount = 0
  private inputTokens = 0
  private outputTokens = 0
  private cachedReadTokens = 0
  private cachedWriteTokens = 0
  private totalTokens = 0
  private costUsd = 0
  private agentActiveMs = 0

  constructor(public readonly groupKey: RollupGroupKey) {}

  /**
   * Build an empty accumulator from any session that belongs to the bucket.
   * Convenience factory mirroring the previous `createEmptyAgentAccumulator`.
   */
  static fromSession(session: AgentUsageSession): RollupAccumulator {
    return new RollupAccumulator(AgentRollupGroupKey.fromSession(session).toGroupKey())
  }

  /**
   * Accumulate a session's contribution to this bucket.
   *
   * @param fraction proportion of the session's totals that falls inside the
   *                 bucket (1.0 if fully inside, ∈ (0,1) if cross-midnight).
   * @param overlapMs ms of activity inside the bucket.
   */
  add(session: AgentUsageSession, fraction: number, overlapMs: number): void {
    const inputTokens = Math.round(session.inputTokens * fraction)
    const outputTokens = Math.round(session.outputTokens * fraction)
    const cachedReadTokens = Math.round(session.cachedReadTokens * fraction)
    const cachedWriteTokens = Math.round(session.cachedWriteTokens * fraction)
    const totalTokens = Math.round(session.totalTokens * fraction)
    const costUsd = session.costUsd * fraction

    this.sessionCount += 1
    this.incrementStatusCounter(session.status)
    this.inputTokens += inputTokens
    this.outputTokens += outputTokens
    this.cachedReadTokens += cachedReadTokens
    this.cachedWriteTokens += cachedWriteTokens
    this.totalTokens += totalTokens
    this.costUsd += costUsd
    this.agentActiveMs += overlapMs

    this.accumulateModelMix(session, {
      inputTokens,
      outputTokens,
      cachedReadTokens,
      totalTokens,
      costUsd,
    })
    this.accumulateModelHealth(session)
  }

  /**
   * Materialise the accumulator as an `AgentUsageRollupHourly` doc with
   * the hour-bucket fields filled in by the caller (so the accumulator
   * stays decoupled from the persistence loop).
   */
  toDoc(input: {
    rollupId: string
    hourBucket: Date
    computedAt: Date
    jobRunId: string
  }): AgentUsageRollupHourly {
    return {
      rollupId: input.rollupId,
      hourBucket: input.hourBucket,
      groupKey: this.groupKey,
      modelMix: this.modelMix,
      modelHealth: this.modelHealth,
      sessionCount: this.sessionCount,
      completedCount: this.completedCount,
      erroredCount: this.erroredCount,
      timedOutCount: this.timedOutCount,
      abortedCount: this.abortedCount,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cachedReadTokens: this.cachedReadTokens,
      cachedWriteTokens: this.cachedWriteTokens,
      totalTokens: this.totalTokens,
      costUsd: this.costUsd,
      agentActiveMs: this.agentActiveMs,
      computedAt: input.computedAt,
      jobRunId: input.jobRunId,
      schemaVersion: 1,
      createdAt: input.computedAt,
    }
  }

  private incrementStatusCounter(status: AgentUsageSession["status"]): void {
    switch (status) {
      case "completed":
        this.completedCount += 1
        break
      case "errored":
        this.erroredCount += 1
        break
      case "timed_out":
        this.timedOutCount += 1
        break
      case "aborted":
        this.abortedCount += 1
        break
      default:
        break
    }
  }

  private accumulateModelMix(
    session: AgentUsageSession,
    deltas: {
      inputTokens: number
      outputTokens: number
      cachedReadTokens: number
      totalTokens: number
      costUsd: number
    },
  ): void {
    const model = session.actualModel ?? session.modelId
    const existing: ModelMixEntry = this.modelMix[model] ?? {
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      sessionCount: 0,
    }
    existing.inputTokens += deltas.inputTokens
    existing.outputTokens += deltas.outputTokens
    existing.cachedReadTokens += deltas.cachedReadTokens
    existing.totalTokens += deltas.totalTokens
    existing.costUsd += deltas.costUsd
    existing.sessionCount += 1
    this.modelMix[model] = existing
  }

  /**
   * Accumulate the per-`actualProvider×modelId` health distribution (TER-616/F1).
   * Delegates to the shared `accumulateSessionModelHealth` so the rollup and the
   * live in-progress-hour path (handler) can never diverge (TER-645/#2).
   */
  private accumulateModelHealth(session: AgentUsageSession): void {
    accumulateSessionModelHealth(this.modelHealth, session)
  }
}
