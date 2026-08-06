/**
 * Event applier: consumes AgentUsageEvent and projects to:
 *   - agent_usage_sessions
 *   - tool_executions
 *
 * Idempotency: each event is "claimed" in agent_usage_event_applications
 * before applying. If claim returns false (dup key), the event was already
 * applied and is skipped silently. Robust across process restarts.
 *
 * Descendant propagation: when applying `session.ended` to a child session,
 * descendant counters are propagated to the parent ONLY if the child update
 * actually wrote (matchedCount > 0). This guards against double-propagation
 * when an event is replayed outside the applier path (e.g. manual Mongo shell
 * replay after `agent_usage_event_applications` was wiped operationally).
 *
 *
 */

import type { Logger } from "pino"
import type { AgentUsageEvent, AgentUsageSession, ToolExecution } from "../types/database.js"
import type { AgentUsageEventApplicationsRepository } from "./agent-usage-event-applications-repository.js"
import type { AgentUsageSessionRepository } from "./agent-usage-session-repository.js"
import type { LatitudeScoreEmitter } from "./latitude-score-emitter.js"
import type { SessionTraceExporter } from "./session-trace-export-service.js"
import type { ToolExecutionRepository } from "./tool-execution-repository.js"

export class AgentUsageEventApplier {
  constructor(
    private readonly applications: AgentUsageEventApplicationsRepository,
    private readonly sessions: AgentUsageSessionRepository,
    private readonly tools: ToolExecutionRepository,
    private readonly log: Logger,
    /**
     * F3a — optional Latitude export. Present in the server wiring, ABSENT in
     * the rebuild/replay scripts so historical projections never re-export
     * (adversarial finding M-D).
     */
    private readonly traceExporter?: SessionTraceExporter,
    /**
     * F4·C0 — optional Latitude score emitter. Same DI shape as the exporter:
     * present in the server wiring, ABSENT in rebuild/replay so historical
     * projections never re-score.
     */
    private readonly scoreEmitter?: LatitudeScoreEmitter,
  ) {}

  /**
   * Apply a batch of events. Each event is claimed individually; failures of
   * one event do not abort the rest.
   *
   * Returns the count of newly applied events (those not previously claimed).
   */
  async applyBatch(events: AgentUsageEvent[]): Promise<number> {
    let applied = 0
    for (const event of events) {
      try {
        const claimed = await this.applications.tryClaim(event.eventId)
        if (!claimed) continue
        await this.applyOne(event)
        applied++
      } catch (err) {
        this.log.error(
          { err, eventId: event.eventId, type: event.type },
          "agent-usage-event-applier: apply failed",
        )
      }
    }
    return applied
  }

  private async applyOne(event: AgentUsageEvent): Promise<void> {
    switch (event.type) {
      case "session.started":
        await this.onSessionStarted(event)
        return
      case "session.running":
        await this.onSessionRunning(event)
        return
      case "session.delta":
        await this.onSessionDelta(event)
        return
      case "session.ended":
        await this.onSessionEnded(event)
        return
      case "tool.started":
        await this.onToolStarted(event)
        return
      case "tool.ended":
        await this.onToolEnded(event)
        return
      default: {
        // Exhaustive check at compile time
        const _exhaustive: never = event
        void _exhaustive
      }
    }
  }

  private async onSessionStarted(
    event: Extract<AgentUsageEvent, { type: "session.started" }>,
  ): Promise<void> {
    const { sessionUsageId, payload } = event
    const doc: AgentUsageSession = {
      sessionUsageId,
      parentSessionUsageId: payload.parentSessionUsageId,
      // Denormalized root of the delegation tree (F3a). Fall back to the
      // session's own id for events emitted before F3a (top-level correct).
      rootSessionUsageId: payload.rootSessionUsageId ?? sessionUsageId,
      triggerKind: payload.triggerKind,
      userId: payload.userId,
      agentId: payload.agentId,
      workspaceId: payload.workspaceId,
      channelId: payload.channelId,
      coreId: payload.coreId,
      provider: payload.provider,
      modelId: payload.modelId,
      // Seed the expected upstream so error/timeout turns (which never emit
      // session.delta) bucket under the real upstream, not the `teros` alias
      // (TER-616/C1). A successful turn overwrites these via onSessionDelta.
      actualModel: payload.actualModel,
      actualProvider: payload.actualProvider,
      // The session opens `queued` with no execution anchor. `session.running`
      // sets the authoritative `startedAt` on turn start (TER-650/G1). A queued
      // session (startedAt=null) is excluded from the billing rollup by
      // construction (its overlap filter requires a startedAt) and reconciled by
      // `createdAt` if its worker dies before it ever runs.
      startedAt: null,
      endedAt: null,
      durationMs: null,
      durationSource: null,
      status: "queued",
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      descendantInputTokens: 0,
      descendantOutputTokens: 0,
      descendantCostUsd: 0,
      descendantSessionCount: 0,
      llmCallCount: 0,
      toolCallCount: 0,
      schemaVersion: 1,
      createdAt: event.appliedAt,
      updatedAt: event.appliedAt,
    }
    await this.sessions.insert(doc)
  }

  private async onSessionRunning(
    event: Extract<AgentUsageEvent, { type: "session.running" }>,
  ): Promise<void> {
    const { sessionUsageId, payload } = event
    // Guard against clock skew: a startedAt in the future would never match the
    // reconciler's execution-orphan cutoff (`startedAt < cutoff`) and could leak
    // as an eternal `running` zombie. Clamp to the apply time and surface it.
    let startedAt = payload.startedAt
    if (startedAt.getTime() > event.appliedAt.getTime()) {
      this.log.warn(
        {
          sessionUsageId,
          startedAt,
          appliedAt: event.appliedAt,
          skewMs: startedAt.getTime() - event.appliedAt.getTime(),
        },
        "agent-usage-applier: session.running startedAt is in the future — clamped to appliedAt",
      )
      startedAt = event.appliedAt
    }
    // Only a `queued` session transitions to `running`. The `{status:'queued'}`
    // filter makes this idempotent (a replay or double markRunning is a no-op)
    // and ensures a session already closed by the reconciler is never revived.
    await this.sessions.update(
      sessionUsageId,
      { $set: { status: "running", startedAt, updatedAt: event.appliedAt } },
      { status: "queued" },
    )
  }

  private async onSessionDelta(
    event: Extract<AgentUsageEvent, { type: "session.delta" }>,
  ): Promise<void> {
    const { sessionUsageId, payload } = event
    const inc: Record<string, number> = {
      inputTokens: payload.inputTokens,
      outputTokens: payload.outputTokens,
      cachedReadTokens: payload.cachedReadTokens,
      cachedWriteTokens: payload.cachedWriteTokens,
      reasoningTokens: payload.reasoningTokens,
      costUsd: payload.costUsd,
      // inputTokens excludes cached (A2.1); keep totalTokens as the processed
      // figure by including cache reads.
      totalTokens: payload.inputTokens + payload.cachedReadTokens + payload.outputTokens,
      llmCallCount: payload.llmCallCount,
      toolCallCount: payload.toolCallCount,
    }
    // Token breakdown is accumulated via $inc into the embedded
    // `tokenBreakdown.*` doc so that the projection survives multiple
    // delta events per session (only one today, but tomorrow we may
    // split per-LLM-call). Missing payload → fields stay untouched.
    if (payload.tokenBreakdown) {
      inc["tokenBreakdown.system"] = payload.tokenBreakdown.system
      inc["tokenBreakdown.tools"] = payload.tokenBreakdown.tools
      inc["tokenBreakdown.examples"] = payload.tokenBreakdown.examples
      inc["tokenBreakdown.memory"] = payload.tokenBreakdown.memory
      inc["tokenBreakdown.summary"] = payload.tokenBreakdown.summary
      inc["tokenBreakdown.conversation"] = payload.tokenBreakdown.conversation
      inc["tokenBreakdown.toolCalls"] = payload.tokenBreakdown.toolCalls
      inc["tokenBreakdown.toolResults"] = payload.tokenBreakdown.toolResults
      inc["tokenBreakdown.output"] = payload.tokenBreakdown.output
    }
    // NO status guard (TER-691). On the real path `session.ended` is applied
    // before `session.delta` (the delta callback is fire-and-forget, not awaited
    // by flushCallbacks), so a `{status:"running"}` guard here (TER-650/G1) dropped
    // the $inc on every completed turn → 0 tokens/latency (Model Health blank).
    // tryClaim makes this exactly-once; zombie billing stays guarded by the
    // rollup's isNonBillableSession errorKind check, not here. Do NOT re-add a
    // status filter — agent-usage-lifecycle-g1.test.ts goes red if you do.
    await this.sessions.update(sessionUsageId, {
      $inc: inc,
      $set: {
        ...(payload.actualModel ? { actualModel: payload.actualModel } : {}),
        // TER-616/F1: project the upstream + degradation telemetry F0 emits.
        // $set (last-delta wins) — one delta per session today; for multi-delta
        // sessions the last turn's figures are representative.
        ...(payload.actualProvider ? { actualProvider: payload.actualProvider } : {}),
        ...(payload.latencyMs !== undefined ? { latencyMs: payload.latencyMs } : {}),
        ...(payload.ttftMs !== undefined ? { ttftMs: payload.ttftMs } : {}),
        ...(payload.usagePartial !== undefined ? { usagePartial: payload.usagePartial } : {}),
        // Quality + failover proxies (§3.1 + TER-617/F3) — last-delta wins.
        ...(payload.stopReason ? { stopReason: payload.stopReason } : {}),
        ...(payload.fallbackUsed !== undefined ? { fallbackUsed: payload.fallbackUsed } : {}),
        ...(payload.primaryErrorClass ? { primaryErrorClass: payload.primaryErrorClass } : {}),
        updatedAt: event.appliedAt,
      },
    })
  }

  private async onSessionEnded(
    event: Extract<AgentUsageEvent, { type: "session.ended" }>,
  ): Promise<void> {
    const { sessionUsageId, payload } = event

    // Filter on the two non-terminal states so the close is idempotent on
    // replays and never overwrites a terminal status (a clean close or a
    // reconciler timeout). A turn can end straight from `queued` — cancelled or
    // failed before it ever ran (TER-650/G1) — so both are accepted.
    const set: Partial<AgentUsageSession> = {
      endedAt: payload.endedAt,
      durationMs: payload.durationMs,
      durationSource: payload.durationSource,
      status: payload.status,
      updatedAt: event.appliedAt,
    }
    if (payload.errorKind) set.errorKind = payload.errorKind
    if (payload.errorMessage) set.errorMessage = payload.errorMessage
    // Honest-attribution sub-reason + literal upstream text (TER-698). Both ride
    // on session.ended (never session.delta) so they survive order-independently
    // and land on hard-failed turns that never emit a delta.
    if (payload.errorSubReason) set.errorSubReason = payload.errorSubReason
    if (payload.upstreamMessage) set.upstreamMessage = payload.upstreamMessage

    const matched = await this.sessions.update(
      sessionUsageId,
      { $set: set },
      { status: { $in: ["queued", "running"] } },
    )

    // GUARD: if the child was not in `running` (already closed by an earlier
    // event or by the reconciler), do NOT propagate descendant counters to
    // the parent — they were already propagated the first time this event
    // succeeded, and reapplying would double-count.
    if (!matched) return

    // F3a — export this turn's trace to Latitude. Fire-and-forget: the trigger
    // returns immediately; the queries + assemble + build + export run detached
    // with a concurrency cap. NEVER awaited here — awaiting in the applyBatch
    // loop would delay the next event and, on a saturated buffer, drop
    // `session.delta` = billing (adversarial finding M-A). Gated behind the
    // idempotency `matched` so a replay never double-exports.
    this.traceExporter?.exportTurn(sessionUsageId)

    // F4·C0 — emit a categorical failure score for this turn (fire-and-forget,
    // same seam as the export). Hooked here, NOT in onToolEnded: the score pins
    // to the trace `exportTurn` just handed off, so it must fire once the turn is
    // done (the emitter reads toolErrorCount and only scores when > 0). Gated by
    // `matched` so a replay never double-scores.
    this.scoreEmitter?.emitSessionFailure({ sessionUsageId })

    // Read the parent id from the EVENT payload (denormalized at emit time),
    // not from the doc. This avoids an extra round-trip for top-level turns
    // (parent === null) and removes a write-read race window.
    if (!payload.parentSessionUsageId) return

    // KNOWN LIMITATION (TER-691 follow-up): the propagation below reads the
    // child's counters AT ended-time. Because `session.delta` is emitted after
    // `session.ended` on the real path (see onSessionDelta), a child's late delta
    // lands on the child AFTER this ran → the parent's descendant* totals
    // undercount that child's tokens for delegated (agent↔agent) turns. Top-level
    // turns (parent === null, the vast majority) are unaffected. A robust fix
    // (re-propagate when a late delta lands, or aggregate descendants at read
    // time) is tracked as a separate ticket, out of scope for the RC1 hot fix.
    const session = await this.sessions.findById(sessionUsageId)
    if (!session) return // defensive — should not happen given the matched=true above

    const totalCost = session.costUsd + session.descendantCostUsd
    await this.sessions.update(payload.parentSessionUsageId, {
      $inc: {
        descendantInputTokens: session.inputTokens + session.descendantInputTokens,
        descendantOutputTokens: session.outputTokens + session.descendantOutputTokens,
        descendantCostUsd: totalCost,
        descendantSessionCount: 1 + session.descendantSessionCount,
      },
      $set: { updatedAt: event.appliedAt },
    })
  }

  private async onToolStarted(
    event: Extract<AgentUsageEvent, { type: "tool.started" }>,
  ): Promise<void> {
    const { sessionUsageId, toolExecutionId, payload } = event
    const doc: ToolExecution = {
      toolExecutionId,
      sessionUsageId,
      channelId: payload.channelId,
      userId: payload.userId,
      agentId: payload.agentId,
      workspaceId: payload.workspaceId,
      stepIndex: payload.stepIndex,
      toolCallIndex: payload.toolCallIndex,
      toolName: payload.toolName,
      mcaId: payload.mcaId,
      startedAt: payload.startedAt,
      endedAt: null,
      durationMs: null,
      durationSource: null,
      status: "running",
      inputSizeBytes: payload.inputSizeBytes,
      schemaVersion: 1,
      createdAt: event.appliedAt,
    }
    await this.tools.insert(doc)
  }

  private async onToolEnded(
    event: Extract<AgentUsageEvent, { type: "tool.ended" }>,
  ): Promise<void> {
    const { toolExecutionId, payload } = event
    const set: Partial<ToolExecution> = {
      endedAt: payload.endedAt,
      durationMs: payload.durationMs,
      durationSource: payload.durationSource,
      status: payload.status,
    }
    if (payload.errorMessage) set.errorMessage = payload.errorMessage
    if (payload.outputSizeBytes !== undefined) set.outputSizeBytes = payload.outputSizeBytes

    // status='running' filter makes this idempotent: only the FIRST application
    // of this tool.ended transitions the doc out of running (matched=true).
    const matched = await this.tools.update(toolExecutionId, { $set: set }, { status: "running" })

    // Per-upstream tool-error-rate (TER-616/R4.3): count failing tools onto the
    // session doc so the hourly rollup can derive toolErrorRate by
    // actualProvider×modelId. Gated on `matched` (A1.8): a manual replay after
    // `agent_usage_event_applications` was wiped would re-run this event with the
    // tool doc already in `error` → matched=false → we skip the $inc instead of
    // double-counting. On the first (real) application the doc is `running` →
    // matched=true. session.started always precedes tool.ended (appliedAt order),
    // so the session doc exists; the update stays a no-op-if-absent (no upsert).
    if (payload.status === "error" && matched) {
      await this.sessions.update(event.sessionUsageId, {
        $inc: { toolErrorCount: 1 },
      })
    }
  }
}
