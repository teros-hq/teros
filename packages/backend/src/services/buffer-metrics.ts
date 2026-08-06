/**
 * Internal metrics for the agent usage event buffer.
 *
 * Encapsulates the counters + latency distribution that previously lived as
 * private fields on `UsageEventBuffer`. Single Responsibility: this class
 * does NOT touch the queue or the DB — it only counts.
 *
 * Extracted from `UsageEventBuffer` as part of R1 (refactor plan). Snapshot
 * is the only read path; mutations happen through the `*increment*` and
 * `record*` methods.
 *
 * Quantile implementation: linear interpolation on the sorted samples
 * (sliding window of the last 1000). Cheap enough for the per-flush call
 * site; if the volume grows we'd switch to a sketch (HDR / t-digest).
 *
 *
 */

import type { UsageEventBufferMetrics } from "./usage-event-buffer.js"

const MAX_LATENCY_SAMPLES = 1000

export class BufferMetrics {
  private enqueued = 0
  private flushed = 0
  private dropped = 0
  private retried = 0
  private flushErrors = 0
  private queueDepthHighWater = 0
  private latencySamples: number[] = []

  incrementEnqueued(): void {
    this.enqueued++
  }

  incrementFlushed(n: number): void {
    this.flushed += n
  }

  incrementDropped(): void {
    this.dropped++
  }

  incrementRetried(): void {
    this.retried++
  }

  incrementFlushErrors(): void {
    this.flushErrors++
  }

  /**
   * Records the current queue depth and updates the high-water mark if
   * applicable. Called whenever an event is enqueued.
   */
  recordQueueDepth(depth: number): void {
    if (depth > this.queueDepthHighWater) {
      this.queueDepthHighWater = depth
    }
  }

  recordFlushLatencyMs(ms: number): void {
    this.latencySamples.push(ms)
    if (this.latencySamples.length > MAX_LATENCY_SAMPLES) this.latencySamples.shift()
  }

  /**
   * Produce a snapshot of all metrics suitable for the /metrics Prometheus
   * exposition. `currentQueueDepth` and `deadLetterTotalSizeBytes` are
   * passed in because they live in the owner (buffer) and on disk
   * respectively — this class does not own them.
   */
  snapshot(currentQueueDepth: number, deadLetterTotalSizeBytes: number): UsageEventBufferMetrics {
    const sorted = [...this.latencySamples].sort((a, b) => a - b)
    return {
      events_enqueued: this.enqueued,
      events_flushed: this.flushed,
      events_dropped: this.dropped,
      events_retried: this.retried,
      flush_errors: this.flushErrors,
      flush_latency_ms_p50: quantile(sorted, 0.5),
      flush_latency_ms_p95: quantile(sorted, 0.95),
      queue_depth: currentQueueDepth,
      queue_depth_high_water: this.queueDepthHighWater,
      dead_letter_total_size_bytes: deadLetterTotalSizeBytes,
    }
  }
}

/**
 * Linear-interpolated quantile of a sorted ascending array. Returns 0 for
 * an empty input (no samples yet).
 */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  if (base + 1 < sorted.length) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base])
  }
  return sorted[base]
}
