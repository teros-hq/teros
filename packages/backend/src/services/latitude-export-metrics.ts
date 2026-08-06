/**
 * Health metrics for the Latitude OTLP export (F3a).
 *
 * Mirrors `buffer-metrics.ts`: a plain counter/gauge holder, snapshotted onto
 * `/metrics` and polled by the Sentry alerter. Without this you can't tell in
 * prod whether the enabler is actually shipping spans or silently failing.
 *
 * Implements `SessionTraceExportMetrics` (consumed by the export service) and
 * feeds the exporter's per-batch result hook (`onExportResult`). `latitude_
 * reachable` is the last batch's outcome (1 ok / 0 failed); `last_export_ok_at`
 * lets the alerter fire on staleness, not just on an explicit failure.
 */

import type { SessionTraceExportMetrics } from "./session-trace-export-service.js"

export interface LatitudeExportMetricsSnapshot {
  spans_enqueued: number
  spans_exported: number
  spans_failed: number
  /** Turns dropped by the concurrency cap (best-effort telemetry, not billing). */
  turns_dropped: number
  build_errors: number
  export_batches_ok: number
  export_batches_failed: number
  in_flight: number
  /** 1 if the last batch succeeded, 0 if it failed. Starts 1 (assume reachable). */
  latitude_reachable: number
  /** Epoch ms of the last successful batch; 0 if none yet. */
  last_export_ok_at_ms: number
}

export class LatitudeExportMetrics implements SessionTraceExportMetrics {
  private spansEnqueued = 0
  private spansExported = 0
  private spansFailed = 0
  private turnsDropped = 0
  private buildErrors = 0
  private batchesOk = 0
  private batchesFailed = 0
  private inFlight = 0
  private lastOkAtMs = 0
  private lastResultOk = true

  /** Injectable clock for deterministic tests. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  recordEnqueued(spanCount: number): void {
    this.spansEnqueued += spanCount
  }

  recordExportResult(ok: boolean, spanCount: number): void {
    if (ok) {
      this.spansExported += spanCount
      this.batchesOk++
      this.lastOkAtMs = this.now()
      this.lastResultOk = true
    } else {
      this.spansFailed += spanCount
      this.batchesFailed++
      this.lastResultOk = false
    }
  }

  recordBuildError(): void {
    this.buildErrors++
  }

  recordDropped(): void {
    this.turnsDropped++
  }

  setInFlight(n: number): void {
    this.inFlight = n
  }

  snapshot(): LatitudeExportMetricsSnapshot {
    return {
      spans_enqueued: this.spansEnqueued,
      spans_exported: this.spansExported,
      spans_failed: this.spansFailed,
      turns_dropped: this.turnsDropped,
      build_errors: this.buildErrors,
      export_batches_ok: this.batchesOk,
      export_batches_failed: this.batchesFailed,
      in_flight: this.inFlight,
      latitude_reachable: this.lastResultOk ? 1 : 0,
      last_export_ok_at_ms: this.lastOkAtMs,
    }
  }
}
