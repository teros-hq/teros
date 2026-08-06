/**
 * /metrics endpoint — Prometheus exposition format.
 *
 * Exposes agent usage instrumentation metrics for time-series scraping. Even
 * if no Prometheus is connected today, the endpoint is futureproof: the day
 * the team plugs in a scraper, no migration is needed.
 *
 * Authentication: open to internal network only. The admin reverse proxy
 * should restrict /metrics to private IPs / VPN. We don't enforce auth here
 * because Prometheus scraping is unauthenticated by default.
 *
 * Sentry handles event-based alarms (drops, persist errors, lag, dead letter
 * bloat) — see agent-usage-sentry-alerts.ts.
 *
 *
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import type { Db } from "mongodb"
import { INSTANCE_ID } from "../lib/instance-id.js"
import type { AgentHoursTracker } from "../services/agent-hours-tracker.js"
import type { AgentUsageReconciler } from "../services/agent-usage-reconciler.js"
import type { AgentUsageRollupJob } from "../services/agent-usage-rollup-job.js"
import type { BillingReconciliationCron } from "../services/billing-reconciliation-cron.js"
import type { BillingResetCron } from "../services/billing-reset-cron.js"
import type { BillingChargeCron } from "../services/billing-charge-cron.js"
import {
  aggregateModelHealth,
  type ModelHealthSummary,
} from "../services/model-health-aggregator.js"
import { EXCLUDE_DEMO_SEED } from "../services/agent-usage-demo-filter.js"
import type {
  LatitudeExportMetrics,
  LatitudeExportMetricsSnapshot,
} from "../services/latitude-export-metrics.js"
import type {
  LatitudeScoreMetricsRecorder,
  LatitudeScoreMetricsSnapshot,
} from "../services/latitude-score-metrics.js"
import type { UsageEventBuffer } from "../services/usage-event-buffer.js"
import type { AgentUsageRollupHourly } from "../types/database.js"
import { getInflightSnapshot } from "@teros/core"

export interface MetricsHandlerDeps {
  buffer: UsageEventBuffer
  reconciler: AgentUsageReconciler
  rollup: AgentUsageRollupJob
  tracker: AgentHoursTracker
  resetCron: BillingResetCron
  reconciliationCron: BillingReconciliationCron
  chargeCron: BillingChargeCron
  /** Read handle for the per-`actualProvider×modelId` model-health series (R5). */
  db: Db
  /** F3a — Latitude export health counters. Absent when the export is not wired. */
  latitudeExport?: LatitudeExportMetrics
  /** F4·C0 — Latitude score emitter health counters. Absent when the emitter is not wired. */
  latitudeScores?: LatitudeScoreMetricsRecorder
}

/**
 * Escape a Prometheus label value (RFC: backslash, double quote, newline).
 */
function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
}

/**
 * Handler signature compatible with http-server.ts routing.
 *
 * Returns `true` if the request was handled.
 */
export function createMetricsRoute(deps: MetricsHandlerDeps) {
  return async function metricsRoute(
    _req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<boolean> {
    if (url !== "/metrics") return false

    try {
      const [
        bufferMetrics,
        reconcileMetrics,
        rollupMetrics,
        trackerMetrics,
        resetMetrics,
        reconciliationMetrics,
        chargeMetrics,
      ] = await Promise.all([
        deps.buffer.getMetrics(),
        Promise.resolve(deps.reconciler.getMetrics()),
        Promise.resolve(deps.rollup.getMetrics()),
        Promise.resolve(deps.tracker.getMetrics()),
        Promise.resolve(deps.resetCron.getMetrics()),
        Promise.resolve(deps.reconciliationCron.getMetrics()),
        Promise.resolve(deps.chargeCron.getMetrics()),
      ])

      const lines: string[] = []
      const labels = `{instance="${escapeLabel(INSTANCE_ID)}"}`
      // Buffer (gauges + counters)
      appendCounter(
        lines,
        "agent_usage_events_enqueued_total",
        "Events enqueued in the usage buffer since process start",
        bufferMetrics.events_enqueued,
        labels,
      )
      appendCounter(
        lines,
        "agent_usage_events_flushed_total",
        "Events successfully written to agent_usage_events",
        bufferMetrics.events_flushed,
        labels,
      )
      appendCounter(
        lines,
        "agent_usage_events_dropped_total",
        "Events dropped because the queue was saturated",
        bufferMetrics.events_dropped,
        labels,
      )
      appendCounter(
        lines,
        "agent_usage_events_retried_total",
        "Flush retries (Mongo write failures)",
        bufferMetrics.events_retried,
        labels,
      )
      appendCounter(
        lines,
        "agent_usage_flush_errors_total",
        "Persistent flush failures (sent to dead-letter)",
        bufferMetrics.flush_errors,
        labels,
      )
      appendGauge(
        lines,
        "agent_usage_flush_latency_ms_p50",
        "p50 flush latency in milliseconds",
        bufferMetrics.flush_latency_ms_p50,
        labels,
      )
      appendGauge(
        lines,
        "agent_usage_flush_latency_ms_p95",
        "p95 flush latency in milliseconds",
        bufferMetrics.flush_latency_ms_p95,
        labels,
      )
      appendGauge(
        lines,
        "agent_usage_queue_depth",
        "Current in-memory queue depth",
        bufferMetrics.queue_depth,
        labels,
      )
      appendGauge(
        lines,
        "agent_usage_queue_depth_high_water",
        "Historical maximum queue depth",
        bufferMetrics.queue_depth_high_water,
        labels,
      )
      appendGauge(
        lines,
        "agent_usage_dead_letter_total_size_bytes",
        "Sum of pending dead-letter file sizes",
        bufferMetrics.dead_letter_total_size_bytes,
        labels,
      )

      // Reconciler
      appendCounter(
        lines,
        "agent_usage_reconcile_sessions_closed_total",
        "Orphan sessions closed by the reconciler",
        reconcileMetrics.reconcile_sessions_closed,
        labels,
      )
      appendCounter(
        lines,
        "agent_usage_reconcile_tools_closed_total",
        "Orphan tool executions closed by the reconciler",
        reconcileMetrics.reconcile_tools_closed,
        labels,
      )
      appendCounter(
        lines,
        "agent_usage_reconcile_errors_total",
        "Errors during reconciliation",
        reconcileMetrics.reconcile_errors,
        labels,
      )
      appendCounter(
        lines,
        "agent_usage_reconcile_skipped_not_leader_total",
        "Reconciler ticks skipped because another instance held the leader lock",
        reconcileMetrics.reconcile_skipped_not_leader,
        labels,
      )

      // Rollup
      appendGauge(
        lines,
        "agent_usage_rollup_job_duration_ms",
        "Duration of the last rollup job tick",
        rollupMetrics.rollup_job_duration_ms,
        labels,
      )
      appendCounter(
        lines,
        "agent_usage_rollup_docs_written_total",
        "Rollup documents upserted",
        rollupMetrics.rollup_docs_written,
        labels,
      )
      appendCounter(
        lines,
        "agent_usage_rollup_errors_total",
        "Errors during rollup",
        rollupMetrics.rollup_errors,
        labels,
      )
      appendGauge(
        lines,
        "agent_usage_rollup_lag_hours",
        "Hours behind the current hour in rollups",
        rollupMetrics.rollup_lag_hours,
        labels,
      )
      appendCounter(
        lines,
        "agent_usage_rollup_skipped_not_leader_total",
        "Rollup ticks skipped because another instance held the leader lock",
        rollupMetrics.rollup_skipped_not_leader,
        labels,
      )

      // Agent Hours Tracker
      appendCounter(
        lines,
        "agent_hours_tracker_runs_total",
        "Tracker ticks executed",
        trackerMetrics.tracker_runs,
        labels,
      )
      appendCounter(
        lines,
        "agent_hours_tracker_users_billed_total",
        "Users billed in tracker ticks",
        trackerMetrics.tracker_users_billed,
        labels,
      )
      appendCounter(
        lines,
        "agent_hours_tracker_hours_added_total",
        "Agent hours added to billing_subscriptions",
        trackerMetrics.tracker_hours_added,
        labels,
      )
      appendCounter(
        lines,
        "agent_hours_tracker_ledger_entries_total",
        "Append-only billing_hour_ledger entries written by the tracker",
        trackerMetrics.tracker_ledger_entries,
        labels,
      )
      appendCounter(
        lines,
        "agent_hours_tracker_errors_total",
        "Errors during tracker execution",
        trackerMetrics.tracker_errors,
        labels,
      )
      appendCounter(
        lines,
        "agent_hours_tracker_skipped_not_leader_total",
        "Tracker ticks skipped because another instance held the leader lock",
        trackerMetrics.tracker_skipped_not_leader,
        labels,
      )

      // Billing Reset Cron
      appendCounter(
        lines,
        "billing_reset_cron_runs_total",
        "Billing reset cron ticks executed",
        resetMetrics.reset_runs,
        labels,
      )
      appendCounter(
        lines,
        "billing_reset_cron_subscriptions_total",
        "Subscriptions reset by billing cron",
        resetMetrics.reset_subscriptions,
        labels,
      )
      appendCounter(
        lines,
        "billing_reset_cron_snapshots_total",
        "Append-only billing_period_snapshots written at period close",
        resetMetrics.reset_snapshots,
        labels,
      )
      appendCounter(
        lines,
        "billing_reset_cron_errors_total",
        "Errors during billing reset cron execution",
        resetMetrics.reset_errors,
        labels,
      )
      appendCounter(
        lines,
        "billing_reset_cron_skipped_not_leader_total",
        "Billing reset ticks skipped because another instance held the leader lock",
        resetMetrics.reset_skipped_not_leader,
        labels,
      )

      // Billing Reconciliation Cron
      appendCounter(
        lines,
        "billing_reconciliation_runs_total",
        "Billing reconciliation ticks executed",
        reconciliationMetrics.reconciliation_runs,
        labels,
      )
      appendCounter(
        lines,
        "billing_reconciliation_subs_checked_total",
        "Subscriptions reconciled (rollups vs agentHoursUsed)",
        reconciliationMetrics.reconciliation_subs_checked,
        labels,
      )
      appendCounter(
        lines,
        "billing_reconciliation_drift_incidents_total",
        "Subscriptions whose agentHoursUsed drifted past threshold",
        reconciliationMetrics.reconciliation_drift_incidents,
        labels,
      )
      appendGauge(
        lines,
        "billing_reconciliation_max_drift_hours",
        "Largest agentHoursUsed drift (hours) observed in the last run",
        reconciliationMetrics.reconciliation_max_drift_hours,
        labels,
      )
      appendGauge(
        lines,
        "billing_reconciliation_cutoff_stuck_subs",
        "Active subs with rollups unbilled for over 24h in the last run",
        reconciliationMetrics.reconciliation_cutoff_stuck_subs,
        labels,
      )
      appendGauge(
        lines,
        "billing_reconciliation_invoice_duplicates",
        "Duplicate invoice groups found in the last run",
        reconciliationMetrics.reconciliation_invoice_duplicates,
        labels,
      )
      appendGauge(
        lines,
        "billing_reconciliation_stripe_checked",
        "Stripe-charged invoices compared against Stripe in the last run",
        reconciliationMetrics.reconciliation_stripe_checked,
        labels,
      )
      appendGauge(
        lines,
        "billing_reconciliation_stripe_drift",
        "Invoices whose Teros vs Stripe paid-state diverged in the last run",
        reconciliationMetrics.reconciliation_stripe_drift,
        labels,
      )
      appendGauge(
        lines,
        "billing_reconciliation_stripe_healed",
        "Invoices auto-healed to paid after a missed webhook in the last run",
        reconciliationMetrics.reconciliation_stripe_healed,
        labels,
      )
      appendCounter(
        lines,
        "billing_reconciliation_errors_total",
        "Errors during billing reconciliation",
        reconciliationMetrics.reconciliation_errors,
        labels,
      )
      appendCounter(
        lines,
        "billing_reconciliation_skipped_not_leader_total",
        "Reconciliation ticks skipped because another instance held the leader lock",
        reconciliationMetrics.reconciliation_skipped_not_leader,
        labels,
      )

      // Billing Charge Cron (FASE 4)
      appendCounter(
        lines,
        "billing_charge_runs_total",
        "Billing charge ticks executed",
        chargeMetrics.charge_runs,
        labels,
      )
      appendCounter(
        lines,
        "billing_charge_attempts_total",
        "Invoice charge attempts made against Stripe",
        chargeMetrics.charge_attempts,
        labels,
      )
      appendCounter(
        lines,
        "billing_charge_succeeded_total",
        "Invoices successfully charged",
        chargeMetrics.charge_succeeded,
        labels,
      )
      appendCounter(
        lines,
        "billing_charge_failed_total",
        "Invoice charge attempts that failed",
        chargeMetrics.charge_failed,
        labels,
      )
      appendCounter(
        lines,
        "billing_charge_waived_total",
        "€0 invoices waived without charging",
        chargeMetrics.charge_waived,
        labels,
      )
      appendCounter(
        lines,
        "billing_charge_blocked_total",
        "Accounts blocked (invoice uncollectible) after dunning grace expired",
        chargeMetrics.charge_blocked,
        labels,
      )
      appendCounter(
        lines,
        "billing_charge_config_errors_total",
        "Charge attempts blocked by a Stripe config error (not dunned)",
        chargeMetrics.charge_config_errors,
        labels,
      )
      appendCounter(
        lines,
        "billing_charge_errors_total",
        "Unexpected errors during invoice charging",
        chargeMetrics.charge_errors,
        labels,
      )
      appendCounter(
        lines,
        "billing_charge_skipped_not_leader_total",
        "Charge ticks skipped because another instance held the leader lock",
        chargeMetrics.charge_skipped_not_leader,
        labels,
      )

      // Per-`actualProvider×modelId` model-health series (TER-616/§2.4, R5).
      // Read the last hour of rollups and emit one labelled sample per upstream
      // ×model. Best-effort: a query failure leaves the rest of /metrics intact.
      try {
        const from = new Date(Date.now() - 60 * 60 * 1000)
        const rollups = await deps.db
          .collection<AgentUsageRollupHourly>("agent_usage_rollups_hourly")
          .find(
            { hourBucket: { $gte: from }, ...EXCLUDE_DEMO_SEED },
            { projection: { modelHealth: 1 } },
          )
          .toArray()
        appendModelHealthSeries(lines, aggregateModelHealth(rollups))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        lines.push(`# model-health series unavailable: ${escapeLabel(message)}`)
      }

      // Live in-flight gauge (F1.3) — in-memory + synchronous, so it lives
      // outside the rollup try/catch above and can't be taken down by a DB hiccup.
      appendInflightSeries(lines, getInflightSnapshot())

      // Latitude export health (F3a) — in-memory counters, present only when the
      // exporter is wired (LATITUDE_EXPORT_* configured).
      if (deps.latitudeExport) {
        appendLatitudeExportSeries(lines, deps.latitudeExport.snapshot(), labels)
      }

      // Latitude score emitter health (F4·C0) — present only when the emitter is
      // wired (LATITUDE_API_URL + LATITUDE_EXPORT_TOKEN/PROJECT configured).
      if (deps.latitudeScores) {
        appendLatitudeScoreSeries(lines, deps.latitudeScores.snapshot(), labels)
      }

      const body = lines.join("\n") + "\n"
      res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      })
      res.end(body)
    } catch (err) {
      // Never fail the endpoint hard — Prometheus would alert on the 500 alone
      const message = err instanceof Error ? err.message : String(err)
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" })
      res.end(`# metrics endpoint failed: ${message}\n`)
    }
    return true
  }
}

/**
 * Per-`actualProvider×modelId` model-health series (TER-616/R5). One `# HELP`/
 * `# TYPE` per metric name, then one labelled sample per upstream×model — the
 * shape Prometheus expects for a multi-series metric. `model` is the logical
 * modelId, `upstream` the real provider (fireworks|together|…), so a scraper
 * can alert on degradation per upstream without the admin window.
 */
function appendModelHealthSeries(lines: string[], summaries: ModelHealthSummary[]): void {
  if (summaries.length === 0) return
  const metrics: {
    name: string
    type: "counter" | "gauge"
    help: string
    // `null` ⇒ not measurable for this model (e.g. an all-aborted bucket) → the
    // series is OMITTED rather than emitted as a misleading 0 (A3.3/TER-674).
    get: (s: ModelHealthSummary) => number | null
  }[] = [
    { name: "agent_usage_model_requests_total", type: "counter", help: "Turns observed per upstream×model in the last hour", get: (s) => s.requestCount },
    { name: "agent_usage_model_error_rate", type: "gauge", help: "(errored+timed_out)/requests per upstream×model", get: (s) => s.errorRate },
    { name: "agent_usage_model_success_rate", type: "gauge", help: "completed/(requests−aborted) per upstream×model", get: (s) => s.successRate },
    { name: "agent_usage_model_saturation_rate", type: "gauge", help: "(rate_limited+overloaded)/requests per upstream×model", get: (s) => s.saturationRate },
    { name: "agent_usage_model_fallback_rate", type: "gauge", help: "failover turns/requests per upstream×model", get: (s) => s.fallbackRate },
    { name: "agent_usage_model_latency_ms_p95", type: "gauge", help: "p95 end-to-end latency (ms) per upstream×model", get: (s) => s.latency.p95 ?? 0 },
    { name: "agent_usage_model_ttft_ms_p95", type: "gauge", help: "p95 time-to-first-token (ms) per upstream×model", get: (s) => s.ttft.p95 ?? 0 },
  ]
  for (const m of metrics) {
    lines.push(`# HELP ${m.name} ${m.help}`)
    lines.push(`# TYPE ${m.name} ${m.type}`)
    for (const s of summaries) {
      const labels =
        `{instance="${escapeLabel(INSTANCE_ID)}",` +
        `upstream="${escapeLabel(s.actualProvider)}",` +
        `model="${escapeLabel(s.modelId)}"}`
      const v = m.get(s)
      // Omit the series when the metric is not measurable — emitting 0 would read
      // as "0% success" (crítico) instead of "no data" (A3.3/TER-674).
      if (v == null) continue
      lines.push(`${m.name}${labels} ${Number.isFinite(v) ? v : 0}`)
    }
  }
}

/**
 * Live in-flight LLM-stream gauge per real upstream (F1.3). Read from the
 * in-memory process counter (NOT `status='running'`), so it reflects THIS
 * instance's current concurrency — the client-side saturation signal serverless
 * providers don't expose. Empty snapshot → metric declared with zero series,
 * which is valid Prometheus.
 */
function appendInflightSeries(lines: string[], snapshot: Record<string, number>): void {
  const name = "agent_usage_inflight_streams"
  lines.push(`# HELP ${name} LLM streams currently in flight on this instance, per upstream`)
  lines.push(`# TYPE ${name} gauge`)
  for (const [provider, count] of Object.entries(snapshot)) {
    const labels = `{instance="${escapeLabel(INSTANCE_ID)}",upstream="${escapeLabel(provider)}"}`
    lines.push(`${name}${labels} ${Number.isFinite(count) ? count : 0}`)
  }
}

/**
 * Latitude export health series (F3a). Mirrors the buffer metrics shape: a few
 * counters + gauges telling whether the OTLP enabler is actually shipping spans
 * or silently failing. `latitude_reachable` is the last batch's outcome (1/0),
 * `last_export_ok_at_ms` powers the alerter's staleness check.
 */
function appendLatitudeExportSeries(
  lines: string[],
  s: LatitudeExportMetricsSnapshot,
  labels: string,
): void {
  appendCounter(lines, "latitude_export_spans_enqueued_total", "Spans handed to the export queue", s.spans_enqueued, labels)
  appendCounter(lines, "latitude_export_spans_exported_total", "Spans successfully exported to Latitude", s.spans_exported, labels)
  appendCounter(lines, "latitude_export_spans_failed_total", "Spans in batches that failed to export", s.spans_failed, labels)
  appendCounter(lines, "latitude_export_turns_dropped_total", "Turns dropped by the export concurrency cap", s.turns_dropped, labels)
  appendCounter(lines, "latitude_export_build_errors_total", "Errors building a turn's span tree", s.build_errors, labels)
  appendCounter(lines, "latitude_export_batches_ok_total", "Export batches that succeeded", s.export_batches_ok, labels)
  appendCounter(lines, "latitude_export_batches_failed_total", "Export batches that failed", s.export_batches_failed, labels)
  appendGauge(lines, "latitude_export_in_flight", "Turn exports currently building/sending", s.in_flight, labels)
  appendGauge(lines, "latitude_export_reachable", "1 if the last export batch succeeded, else 0", s.latitude_reachable, labels)
  appendGauge(lines, "latitude_export_last_ok_timestamp_ms", "Epoch ms of the last successful export (0 = never)", s.last_export_ok_at_ms, labels)
}

function appendLatitudeScoreSeries(
  lines: string[],
  s: LatitudeScoreMetricsSnapshot,
  labels: string,
): void {
  appendCounter(lines, "latitude_scores_emitted_thumbs_down_total", "Thumbs-down scores emitted to Latitude", s.scores_emitted_thumbs_down, labels)
  appendCounter(lines, "latitude_scores_emitted_tool_error_total", "Tool-error scores emitted to Latitude", s.scores_emitted_tool_error, labels)
  appendCounter(lines, "latitude_scores_delivered_total", "Scores delivered (201) to Latitude", s.scores_delivered, labels)
  appendCounter(lines, "latitude_scores_dropped_cap_total", "Scores dropped by the emitter concurrency cap", s.scores_dropped_cap, labels)
  appendCounter(lines, "latitude_scores_dropped_error_total", "Scores dropped after error / retries exhausted", s.scores_dropped_error, labels)
  appendCounter(lines, "latitude_scores_dropped_trace_not_found_total", "Scores dropped because the trace never flushed", s.scores_dropped_trace_not_found, labels)
  appendCounter(lines, "latitude_scores_dropped_rate_limited_total", "Scores dropped after rate-limit retries exhausted", s.scores_dropped_rate_limited, labels)
  appendCounter(lines, "latitude_scores_trace_not_found_retries_total", "Deferred retries triggered by a not-yet-flushed trace", s.trace_not_found_retries, labels)
  appendGauge(lines, "latitude_scores_in_flight", "Score emit chains currently pending/sending", s.in_flight, labels)
  appendGauge(lines, "latitude_scores_reachable", "1 if the last submit was delivered, else 0", s.latitude_scores_reachable, labels)
  appendGauge(lines, "latitude_scores_last_delivered_timestamp_ms", "Epoch ms of the last delivered score (0 = never)", s.last_delivered_at_ms, labels)
}

function appendCounter(
  lines: string[],
  name: string,
  help: string,
  value: number,
  labels = "",
): void {
  lines.push(`# HELP ${name} ${help}`)
  lines.push(`# TYPE ${name} counter`)
  lines.push(`${name}${labels} ${Number.isFinite(value) ? value : 0}`)
}

function appendGauge(
  lines: string[],
  name: string,
  help: string,
  value: number,
  labels = "",
): void {
  lines.push(`# HELP ${name} ${help}`)
  lines.push(`# TYPE ${name} gauge`)
  lines.push(`${name}${labels} ${Number.isFinite(value) ? value : 0}`)
}
