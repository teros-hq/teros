/**
 * Session-trace export orchestrator (F3a).
 *
 * Encapsulates the WHOLE post-session export block — findById + structure-only
 * queries (`llm_usage`, `tool_executions`) + `assembleTurnTelemetry` +
 * `buildSpanTree` + hand-off to the OTLP transport — behind a single
 * fire-and-forget `exportTurn(sessionUsageId)`.
 *
 * The applier triggers it AFTER the idempotency gate (`matched`) and NEVER
 * awaits it: awaiting inside `applyBatch`'s sequential loop would delay the
 * following events and, on a saturated buffer, drop `session.delta` = billing
 * (adversarial finding M-A). A concurrency cap keeps a burst of `session.ended`
 * from fanning out N× parallel Mongo queries; excess turns are dropped
 * best-effort (telemetry, not billing) and counted.
 *
 * DI: the applier takes this as an OPTIONAL 5th arg. Scripts that rebuild /
 * replay projections construct the applier WITHOUT it, so the historical replay
 * never re-exports (adversarial finding M-D). Determinism of the ids makes any
 * legitimate re-export idempotent in ClickHouse anyway.
 */

import type { Db } from "mongodb"
import type { Logger } from "pino"
import type { AgentUsageSession, LLMUsage, ToolExecution } from "../types/database.js"
import type { SpanTreeExporter } from "./otel-latitude-exporter.js"
import { type SpanAttrValue, buildSpanTree } from "./otel-span-builder.js"
import { assembleTurnTelemetry } from "./session-trace-assembler.js"

/** Health counters, mirrored to /metrics + Sentry in pieza 9. */
export interface SessionTraceExportMetrics {
  recordEnqueued(spanCount: number): void
  recordExportResult(ok: boolean, spanCount: number): void
  recordBuildError(): void
  recordDropped(): void
  setInFlight(n: number): void
}

export interface SessionTraceExporterDeps {
  db: Db
  transport: SpanTreeExporter
  /** Sync, O(1) over the FeatureFlagService cache. Resolved per call — cheap. */
  isEnabled: () => boolean
  log: Logger
  /** Extra attributes for the root invoke_agent span (deployment/env metadata). */
  rootAttrs?: Record<string, SpanAttrValue>
  /** Max concurrent build+export chains. Excess turns are dropped. Default 8. */
  maxConcurrency?: number
  metrics?: SessionTraceExportMetrics
}

export class SessionTraceExporter {
  private inFlight = 0
  private readonly maxConcurrency: number

  constructor(private readonly deps: SessionTraceExporterDeps) {
    this.maxConcurrency = deps.maxConcurrency ?? 8
  }

  /**
   * Fire-and-forget export of one finished turn. Returns immediately. Safe to
   * call unconditionally — no-ops when the flag is off, drops when saturated.
   * NEVER returns a promise the applier could await (M-A).
   */
  exportTurn(sessionUsageId: string): void {
    if (!this.deps.isEnabled()) return
    if (this.inFlight >= this.maxConcurrency) {
      this.deps.metrics?.recordDropped()
      return
    }
    this.inFlight++
    this.deps.metrics?.setInFlight(this.inFlight)
    void this.buildAndExport(sessionUsageId).finally(() => {
      this.inFlight--
      this.deps.metrics?.setInFlight(this.inFlight)
    })
  }

  private async buildAndExport(sessionUsageId: string): Promise<void> {
    try {
      // Own findById — the applier's is gated behind the parent check (only
      // runs for delegated children); the export needs the doc for every turn.
      const session = await this.deps.db
        .collection<AgentUsageSession>("agent_usage_sessions")
        .findOne({ sessionUsageId })
      if (!session) return

      // Structure-only: NO channel_messages / message_feedback (that is text,
      // F3b). One round of two queries per turn.
      const [llmUsages, toolExecutions] = await Promise.all([
        this.deps.db.collection<LLMUsage>("llm_usage").find({ sessionUsageId }).toArray(),
        this.deps.db
          .collection<ToolExecution>("tool_executions")
          .find({ sessionUsageId })
          .toArray(),
      ])

      const telemetry = assembleTurnTelemetry({ session, llmUsages, toolExecutions })
      const spans = buildSpanTree(telemetry, this.deps.rootAttrs ?? {}, { includeContent: false })
      this.deps.transport.export(spans)
    } catch (err) {
      this.deps.log.warn({ err, sessionUsageId }, "latitude trace export failed")
      this.deps.metrics?.recordBuildError()
    }
  }

  /** Drain in-flight exports and shut the transport down (ordered shutdown, pieza 8). */
  async shutdown(): Promise<void> {
    // Wait (bounded) for in-flight builds to hand their spans to the queue so
    // forceFlush actually catches them. Past the deadline is the declared loss window.
    const deadline = Date.now() + 2_000
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    await this.deps.transport.forceFlush()
    await this.deps.transport.shutdown()
  }
}
