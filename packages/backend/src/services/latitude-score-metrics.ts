/**
 * Health metrics for the Latitude score emitter (F4 · C0).
 *
 * Mirror of `latitude-export-metrics.ts`: a plain counter/gauge holder,
 * snapshotted onto `/metrics` and polled by the Sentry alerter. Without it a
 * dropped score (the cap, an unreachable Latitude, a trace that never flushed)
 * is invisible — exactly the silent-failure class Teros guards against.
 *
 * Implements `LatitudeScoreMetrics` (consumed by the emitter). `latitude_scores_
 * reachable` is the last submit's outcome (1 delivered / 0 dropped);
 * `last_delivered_at_ms` lets the alerter fire on staleness, not just failure.
 */

import type { LatitudeScoreMetrics, ScoreReason } from "./latitude-score-emitter.js"

export interface LatitudeScoreMetricsSnapshot {
  scores_emitted_thumbs_down: number
  scores_emitted_tool_error: number
  scores_delivered: number
  /** Dropped by the concurrency cap (best-effort telemetry, not billing). */
  scores_dropped_cap: number
  /** Dropped after retries exhausted / genuine error / uncertain network fault. */
  scores_dropped_error: number
  scores_dropped_trace_not_found: number
  scores_dropped_rate_limited: number
  trace_not_found_retries: number
  in_flight: number
  /** 1 if the last submit was delivered, 0 if dropped. Starts 1 (assume reachable). */
  latitude_scores_reachable: number
  /** Epoch ms of the last delivered score; 0 if none yet. */
  last_delivered_at_ms: number
}

export class LatitudeScoreMetricsRecorder implements LatitudeScoreMetrics {
  private emittedThumbsDown = 0
  private emittedToolError = 0
  private delivered = 0
  private droppedCap = 0
  private droppedError = 0
  private droppedTraceNotFound = 0
  private droppedRateLimited = 0
  private retries = 0
  private inFlight = 0
  private lastDeliveredAtMs = 0
  private lastResultOk = true

  /** Injectable clock for deterministic tests. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  recordEmitted(reason: ScoreReason): void {
    if (reason === "thumbs_down") this.emittedThumbsDown++
    else this.emittedToolError++
  }

  recordDelivered(): void {
    this.delivered++
    this.lastDeliveredAtMs = this.now()
    this.lastResultOk = true
  }

  recordDropped(cause: "cap" | "error" | "trace_not_found" | "rate_limited"): void {
    switch (cause) {
      case "cap":
        this.droppedCap++
        break
      case "error":
        this.droppedError++
        this.lastResultOk = false
        break
      case "trace_not_found":
        this.droppedTraceNotFound++
        this.lastResultOk = false
        break
      case "rate_limited":
        this.droppedRateLimited++
        this.lastResultOk = false
        break
    }
  }

  recordTraceNotFoundRetry(): void {
    this.retries++
  }

  setInFlight(n: number): void {
    this.inFlight = n
  }

  snapshot(): LatitudeScoreMetricsSnapshot {
    return {
      scores_emitted_thumbs_down: this.emittedThumbsDown,
      scores_emitted_tool_error: this.emittedToolError,
      scores_delivered: this.delivered,
      scores_dropped_cap: this.droppedCap,
      scores_dropped_error: this.droppedError,
      scores_dropped_trace_not_found: this.droppedTraceNotFound,
      scores_dropped_rate_limited: this.droppedRateLimited,
      trace_not_found_retries: this.retries,
      in_flight: this.inFlight,
      latitude_scores_reachable: this.lastResultOk ? 1 : 0,
      last_delivered_at_ms: this.lastDeliveredAtMs,
    }
  }
}
