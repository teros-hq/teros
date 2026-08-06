/**
 * Unit tests for BufferMetrics (R1 step 2).
 *
 * The class is a thin counter aggregator + p50/p95 calculator. We assert
 * each counter increments correctly and that the snapshot composes the
 * external `currentQueueDepth` + `deadLetterTotalSizeBytes` inputs.
 */

import { describe, expect, it } from 'bun:test'
import { BufferMetrics } from '../../src/services/buffer-metrics'

describe('BufferMetrics', () => {
  it('starts with all counters at zero', () => {
    const m = new BufferMetrics()
    const snap = m.snapshot(0, 0)
    expect(snap.events_enqueued).toBe(0)
    expect(snap.events_flushed).toBe(0)
    expect(snap.events_dropped).toBe(0)
    expect(snap.events_retried).toBe(0)
    expect(snap.flush_errors).toBe(0)
    expect(snap.flush_latency_ms_p50).toBe(0)
    expect(snap.flush_latency_ms_p95).toBe(0)
    expect(snap.queue_depth).toBe(0)
    expect(snap.queue_depth_high_water).toBe(0)
    expect(snap.dead_letter_total_size_bytes).toBe(0)
  })

  it('increments counters in isolation', () => {
    const m = new BufferMetrics()
    m.incrementEnqueued()
    m.incrementEnqueued()
    m.incrementFlushed(3)
    m.incrementDropped()
    m.incrementRetried()
    m.incrementFlushErrors()
    const snap = m.snapshot(0, 0)
    expect(snap.events_enqueued).toBe(2)
    expect(snap.events_flushed).toBe(3)
    expect(snap.events_dropped).toBe(1)
    expect(snap.events_retried).toBe(1)
    expect(snap.flush_errors).toBe(1)
  })

  it('tracks queue depth high-water monotonically', () => {
    const m = new BufferMetrics()
    m.recordQueueDepth(5)
    m.recordQueueDepth(12)
    m.recordQueueDepth(3) // does NOT lower the high water
    const snap = m.snapshot(3, 0)
    expect(snap.queue_depth).toBe(3)
    expect(snap.queue_depth_high_water).toBe(12)
  })

  it('computes p50 / p95 of recorded latencies', () => {
    const m = new BufferMetrics()
    // Distribution: 1..100. p50 ≈ 50, p95 ≈ 95.
    for (let i = 1; i <= 100; i++) m.recordFlushLatencyMs(i)
    const snap = m.snapshot(0, 0)
    // Linear interpolation produces slightly off-integer values for p50/p95.
    expect(snap.flush_latency_ms_p50).toBeCloseTo(50.5, 0)
    expect(snap.flush_latency_ms_p95).toBeCloseTo(95.05, 0)
  })

  it('caps the latency sample window (oldest dropped)', () => {
    const m = new BufferMetrics()
    // Push 1500 samples; the class keeps only the last 1000.
    for (let i = 0; i < 1500; i++) m.recordFlushLatencyMs(i)
    const snap = m.snapshot(0, 0)
    // First 500 dropped → window now [500..1499]. p50 ≈ 999.5.
    expect(snap.flush_latency_ms_p50).toBeGreaterThan(900)
  })

  it('passes through deadLetterTotalSizeBytes input', () => {
    const m = new BufferMetrics()
    const snap = m.snapshot(0, 12345)
    expect(snap.dead_letter_total_size_bytes).toBe(12345)
  })
})
