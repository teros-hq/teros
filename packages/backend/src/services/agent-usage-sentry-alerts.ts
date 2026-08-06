/**
 * Sentry alarm bridge for agent usage instrumentation.
 *
 * Polls the buffer + reconciler + rollup metrics periodically and emits
 * Sentry events when thresholds are crossed. Event-based (not time-series)
 * because Sentry is errors/messages-shaped; for time-series the /metrics
 * Prometheus endpoint is the right destination.
 *
 * Alarms (design doc §7):
 *   - events_dropped > 0 in 5 min       → warn
 *   - flush_errors > 3 in 5 min         → error
 *   - dead_letter_total_size_bytes > 1G → warn
 *   - rollup_lag_hours > 6              → warn
 *   - delegation_orphan_pct > 0         → warn (computed in query layer; not here)
 *   - reconciled_sessions spike > N     → warn (a burst of orphan/zombie closes
 *                                         in one poll window — the phantom-session
 *                                         signal that went undetected in TER-650)
 */

import type { Db } from "mongodb"
import { captureMessage } from "../lib/sentry.js"
import type { AgentUsageRollupHourly } from "../types/database.js"
import { EXCLUDE_DEMO_SEED } from "./agent-usage-demo-filter.js"
import type { AgentUsageReconciler } from "./agent-usage-reconciler.js"
import type { AgentUsageRollupJob } from "./agent-usage-rollup-job.js"
import { LEADER_LOCKS, type LeaderElectionService } from "./leader-election.js"
import type { LatitudeExportMetrics } from "./latitude-export-metrics.js"
import {
  aggregateModelHealth,
  type ModelHealthSummary,
} from "./model-health-aggregator.js"
import type { UsageEventBuffer } from "./usage-event-buffer.js"
import { latencyLevel, rateLevel } from "@teros/shared"

const ONE_GB = 1024 * 1024 * 1024

export interface AlertThresholds {
  eventsDroppedWindowMs: number
  flushErrorsThreshold: number
  deadLetterMaxBytes: number
  rollupLagMaxHours: number
  /**
   * Orphan/zombie session closes by the reconciler within one poll window above
   * which we page. A burst means turns are hanging en masse — the exact
   * phantom-session signal nobody alerted on in TER-650. Normal steady state is
   * a handful per reconciler tick.
   */
  reconciledSessionsSpikeThreshold: number
  pollIntervalMs: number
  /**
   * Minimum sample before alarming (so a single bad turn on a quiet model never
   * pages). The degradation thresholds themselves are NO LONGER here — they come
   * from the SHARED `@teros/shared` monitoring-thresholds so the pager and the
   * dashboard agree; the pager fires at the CRITICAL level, per model class
   * (TER-670).
   */
  modelHealthMinRequests: number
  modelHealthTtftP95MaxMs: number
  modelHealthErrorRateMax: number
  modelHealthSaturationRateMax: number
  modelHealthFallbackRateMax: number
  /** F3a — new failed export batches per window before alarming. */
  latitudeExportBatchFailThreshold: number
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  eventsDroppedWindowMs: 5 * 60 * 1000,
  flushErrorsThreshold: 3,
  deadLetterMaxBytes: ONE_GB,
  rollupLagMaxHours: 6,
  reconciledSessionsSpikeThreshold: 10,
  pollIntervalMs: 60 * 1000,
  modelHealthMinRequests: 20,
  modelHealthTtftP95MaxMs: 5_000,
  modelHealthErrorRateMax: 0.1,
  modelHealthSaturationRateMax: 0.2,
  modelHealthFallbackRateMax: 0.05,
  latitudeExportBatchFailThreshold: 3,
}

/** A model-health alarm decision (pure data — no Sentry side effect). */
export interface ModelHealthAlert {
  alertType: "ttft_p95" | "error_rate" | "rate_limited" | "spend_gate" | "fallback_rate"
  level: "warning" | "error"
  /** `${actualProvider}::${modelId}` — the dedupe key root. */
  key: string
  context: Record<string, unknown>
}

/**
 * Decide which model-health alarms a set of summaries should raise (TER-616/R5).
 *
 * Pure + exported so the thresholds are unit-testable without Sentry or a DB.
 * Skips models below `modelHealthMinRequests` so a single bad turn on a quiet
 * model never pages. `spend_gate` (a 402) fires on ANY occurrence — it means
 * the upstream account hit a billing wall, never noise.
 */
export function evaluateModelHealthAlerts(
  summaries: ModelHealthSummary[],
  t: AlertThresholds,
): ModelHealthAlert[] {
  const alerts: ModelHealthAlert[] = []
  for (const s of summaries) {
    if (s.requestCount < t.modelHealthMinRequests) continue
    const key = `${s.actualProvider}::${s.modelId}`
    const base = { upstream: s.actualProvider, modelId: s.modelId, requestCount: s.requestCount }
    // Page at the SHARED critical level, scoped to the model's class — a
    // reasoning model that runs 9s TTFT by nature no longer pages (TER-670).
    if (latencyLevel("ttft", s.ttft.p95, s.modelId) === "critical") {
      alerts.push({ alertType: "ttft_p95", level: "warning", key, context: { ...base, ttftP95: s.ttft.p95 } })
    }
    if (rateLevel("error", s.errorRate) === "critical") {
      alerts.push({
        alertType: "error_rate",
        level: "error",
        key,
        context: { ...base, errorRate: s.errorRate, errorCounts: s.errorCounts },
      })
    }
    if (rateLevel("saturation", s.saturationRate) === "critical") {
      alerts.push({ alertType: "rate_limited", level: "warning", key, context: { ...base, saturationRate: s.saturationRate, subReasonCounts: s.subReasonCounts } })
    }
    if ((s.errorCounts.spend_gate ?? 0) > 0) {
      alerts.push({ alertType: "spend_gate", level: "error", key, context: { ...base, spendGate: s.errorCounts.spend_gate, subReasonCounts: s.subReasonCounts } })
    }
    if (rateLevel("fallback", s.fallbackRate) === "critical") {
      alerts.push({ alertType: "fallback_rate", level: "warning", key, context: { ...base, fallbackRate: s.fallbackRate } })
    }
  }
  return alerts
}

/**
 * Whether the reconciler's session-close delta in one poll window is a spike
 * worth paging (TER-650: a burst of orphan/zombie closes means turns are
 * hanging en masse — the phantom-session signal). Skips the first observation
 * (`lastClosed <= 0`) so the startup backlog never reads as a spike. Pure +
 * exported for testing.
 */
export function isReconciledSpike(
  lastClosed: number,
  currentClosed: number,
  threshold: number,
): boolean {
  if (lastClosed <= 0) return false
  return currentClosed - lastClosed >= threshold
}

export class AgentUsageSentryAlerts {
  private timer: NodeJS.Timeout | null = null

  // Snapshots of counters at last poll, to compute deltas in the window.
  private lastDropped = 0
  private lastFlushErrors = 0
  private lastReconcileClosed = 0
  private lastPollAt = Date.now()
  // F3a — export counters at last poll, for windowed deltas.
  private lastExportBatchesFailed = 0
  private lastExportTurnsDropped = 0

  /**
   * Deduplicates model-health alarms by `${key}|${alertType}|${hourBucket}` so a
   * sustained incident pages once per hour, not on every 60s poll. Pruned to the
   * current hour each tick so it stays bounded.
   */
  private alertedModelHealth = new Set<string>()

  constructor(
    private readonly buffer: UsageEventBuffer,
    private readonly reconciler: AgentUsageReconciler,
    private readonly rollup: AgentUsageRollupJob,
    /**
     * Optional distributed leader lock. When set, only the leader instance
     * emits Sentry events — non-leaders skip the poll to avoid N duplicate
     * alerts per incident. Per-instance metrics still flow through the
     * `/metrics` endpoint so a global observability stack (Prometheus +
     * Grafana) can detect issues on any node.
     */
    private readonly leader: LeaderElectionService | null = null,
    /**
     * Read handle for the hourly rollups, used by the model-health alarms
     * (R5). Optional so existing call-sites/tests keep working; when absent
     * the model-health evaluation is a no-op.
     */
    private readonly db: Db | null = null,
    /**
     * F3a — Latitude export health counters. When set, the poll alarms on
     * failing export batches / dropped turns. Optional so existing call-sites
     * and tests keep working; absent → the export alarms are a no-op.
     */
    private readonly latitudeExport: LatitudeExportMetrics | null = null,
    public readonly opts: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
  ) {}

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      this.tick().catch(() => {
        /* never throw from alerts */
      })
    }, this.opts.pollIntervalMs)
    if (typeof this.timer.unref === "function") this.timer.unref()
  }

  /**
   * One scheduled tick. Guarded by the leader lock when in multi-instance
   * mode so Sentry receives a single alert per incident, not N.
   */
  private async tick(): Promise<void> {
    if (this.leader) {
      const acquired = await this.leader.tryAcquire(
        LEADER_LOCKS.SentryAgentUsageAlerts,
        this.opts.pollIntervalMs * 2,
      )
      if (!acquired) return
    }
    await this.poll()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Public for tests.
   */
  async poll(): Promise<void> {
    const now = Date.now()
    const windowMs = now - this.lastPollAt
    const bufferMetrics = await this.buffer.getMetrics()
    const reconcileMetrics = this.reconciler.getMetrics()
    const rollupMetrics = this.rollup.getMetrics()

    const droppedDelta = bufferMetrics.events_dropped - this.lastDropped
    const errorsDelta = bufferMetrics.flush_errors - this.lastFlushErrors

    if (droppedDelta > 0 && windowMs <= this.opts.eventsDroppedWindowMs) {
      captureMessage("usage_instrumentation/drops", "warning", {
        droppedDelta,
        windowMs,
        queueDepth: bufferMetrics.queue_depth,
        highWater: bufferMetrics.queue_depth_high_water,
      })
    }

    if (errorsDelta >= this.opts.flushErrorsThreshold) {
      captureMessage("usage_instrumentation/persist", "error", {
        errorsDelta,
        windowMs,
        deadLetterBytes: bufferMetrics.dead_letter_total_size_bytes,
      })
    }

    if (bufferMetrics.dead_letter_total_size_bytes > this.opts.deadLetterMaxBytes) {
      captureMessage("usage_instrumentation/dead_letter_bloat", "warning", {
        bytes: bufferMetrics.dead_letter_total_size_bytes,
      })
    }

    // Only fire the lag alarm when we have a finite delta. `+Inf` means
    // "no rollups yet" (fresh install) — alerting on it would page on first
    // boot, which is noise. The threshold is the rolling steady-state target.
    if (
      Number.isFinite(rollupMetrics.rollup_lag_hours) &&
      rollupMetrics.rollup_lag_hours > this.opts.rollupLagMaxHours
    ) {
      captureMessage("usage_instrumentation/rollup_lag", "warning", {
        lagHours: rollupMetrics.rollup_lag_hours,
        lastRunAt: rollupMetrics.rollup_last_run_at,
      })
    }

    // Spike of orphan/zombie session closes by the reconciler: turns are
    // hanging en masse (the phantom-session signal, TER-650). Skip the very
    // first poll (snapshot 0 → the whole startup backlog would read as a spike).
    if (
      isReconciledSpike(
        this.lastReconcileClosed,
        reconcileMetrics.reconcile_sessions_closed,
        this.opts.reconciledSessionsSpikeThreshold,
      )
    ) {
      captureMessage("billing/reconciled_timeout_spike", "warning", {
        reconciledDelta: reconcileMetrics.reconcile_sessions_closed - this.lastReconcileClosed,
        windowMs,
        totalClosed: reconcileMetrics.reconcile_sessions_closed,
      })
    }

    // Latitude export health (F3a). Alarm on new failed export batches or
    // dropped turns in the window — the enabler silently failing means Latitude
    // is unreachable/misconfigured and no traces are landing.
    if (this.latitudeExport) {
      const ex = this.latitudeExport.snapshot()
      const failedDelta = ex.export_batches_failed - this.lastExportBatchesFailed
      const droppedDelta = ex.turns_dropped - this.lastExportTurnsDropped
      if (failedDelta >= this.opts.latitudeExportBatchFailThreshold) {
        captureMessage("latitude_export/batches_failing", "warning", {
          failedDelta,
          windowMs,
          reachable: ex.latitude_reachable,
          lastOkAtMs: ex.last_export_ok_at_ms,
        })
      }
      if (droppedDelta > 0) {
        captureMessage("latitude_export/turns_dropped", "warning", {
          droppedDelta,
          windowMs,
          inFlight: ex.in_flight,
        })
      }
      this.lastExportBatchesFailed = ex.export_batches_failed
      this.lastExportTurnsDropped = ex.turns_dropped
    }

    // Update snapshots for next poll
    this.lastDropped = bufferMetrics.events_dropped
    this.lastFlushErrors = bufferMetrics.flush_errors
    this.lastReconcileClosed = reconcileMetrics.reconcile_sessions_closed
    this.lastPollAt = now

    // Model-health alarms (TER-616/§2.4, R5). Wrapped so a query failure never
    // breaks the buffer/reconciler/rollup alarms above.
    try {
      await this.evaluateModelHealth(now)
    } catch {
      /* never throw from alerts */
    }
  }

  /**
   * Evaluate per-`actualProvider×modelId` model health from the last hour's
   * rollups and emit one Sentry message per crossed threshold (TER-616/§2.4,
   * R5). Deduped by (key, alertType, hourBucket) so a sustained incident pages
   * once per hour, not every 60s. No-op when no DB was wired.
   *
   * Public for tests.
   */
  async evaluateModelHealth(now: number): Promise<void> {
    if (!this.db) return
    const hourBucket = new Date(Math.floor(now / 3_600_000) * 3_600_000).toISOString()
    // Last hour of rollups — the steady-state window the thresholds target.
    const from = new Date(now - 60 * 60 * 1000)
    const rollups = await this.db
      .collection<AgentUsageRollupHourly>("agent_usage_rollups_hourly")
      .find(
        { hourBucket: { $gte: from }, ...EXCLUDE_DEMO_SEED },
        { projection: { modelHealth: 1 } },
      )
      .toArray()
    const summaries = aggregateModelHealth(rollups)
    for (const alert of evaluateModelHealthAlerts(summaries, this.opts)) {
      const dedupeKey = `${alert.key}|${alert.alertType}|${hourBucket}`
      if (this.alertedModelHealth.has(dedupeKey)) continue
      this.alertedModelHealth.add(dedupeKey)
      captureMessage(`model_health/${alert.alertType}`, alert.level, alert.context)
    }
    // Prune dedupe keys from previous hours so the set stays bounded.
    for (const k of this.alertedModelHealth) {
      if (!k.endsWith(`|${hourBucket}`)) this.alertedModelHealth.delete(k)
    }
  }
}
