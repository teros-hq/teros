/**
 * Latency histogram — additive bucketed sketch for non-additive percentiles (TER-616 / F1).
 *
 * Why: p50/p95/p99 are NOT additive — you cannot precompute a percentile per
 * hourly rollup bucket and average them across hours. The rollup must store a
 * *distribution* per `actualProvider × modelId × hour` and derive percentiles
 * at query/merge time. A fixed-bucket histogram is the pragmatic sketch here:
 *
 *  - **additive**: merging two histograms = summing their bucket counts, so
 *    hourly rollups compose into a 24h/7d view without losing accuracy;
 *  - **deterministic**: no reservoir sampling, no RNG → unit-testable and
 *    mutation-verifiable (the F1 acceptance criterion);
 *  - **no dependency**: a t-digest is more accurate in the tails but its merge
 *    is non-trivial and needs a lib; for "did p95 latency double?" detection,
 *    log-spaced buckets are enough.
 *
 * Buckets follow the OTel GenAI duration boundaries (base-2 exponential from
 * 10ms), expressed in **milliseconds** to match `latencyMs`/`ttftMs`. The
 * implicit final bucket is the overflow `(81920ms, +inf)`.
 *
 * Percentile derivation follows Prometheus `histogram_quantile`: locate the
 * bucket holding the target rank and interpolate linearly within it.
 */

// The `LatencyHistogram` shape lives in `types/database.ts` (it is persisted in
// the F1 rollup doc); this module owns the LOGIC over it. Re-exported so callers
// can import the type and the helpers from one place.
import type { LatencyHistogram } from "../types/database.js"

export type { LatencyHistogram }

/**
 * Upper-bound (inclusive) of each non-overflow bucket, in ms. A value `v` falls
 * in the first bucket `i` whose `BOUNDS[i] >= v`; values above the last bound
 * land in the overflow bucket (index `BOUNDS.length`).
 */
export const LATENCY_BUCKET_BOUNDS_MS: readonly number[] = [
  10, 20, 40, 80, 160, 320, 640, 1280, 2560, 5120, 10240, 20480, 40960, 81920,
]

/** Overflow bucket index — samples `> LATENCY_BUCKET_BOUNDS_MS[last]` land here. */
export const OVERFLOW_BUCKET_INDEX = LATENCY_BUCKET_BOUNDS_MS.length

/** A fresh, all-zero histogram sized to the bucket bounds. */
export function emptyHistogram(): LatencyHistogram {
  return {
    buckets: new Array(LATENCY_BUCKET_BOUNDS_MS.length + 1).fill(0),
    count: 0,
    sum: 0,
    max: 0,
  }
}

/**
 * Index of the bucket a value belongs to. Negative/zero clamp to bucket 0;
 * values above the last bound return the overflow index (`BOUNDS.length`).
 * Boundary semantics are inclusive on the upper bound (`v <= bound`).
 */
export function bucketIndexFor(valueMs: number): number {
  if (!(valueMs > LATENCY_BUCKET_BOUNDS_MS[0])) return 0 // also catches NaN/≤0 → bucket 0
  for (let i = 0; i < LATENCY_BUCKET_BOUNDS_MS.length; i++) {
    if (valueMs <= LATENCY_BUCKET_BOUNDS_MS[i]) return i
  }
  return LATENCY_BUCKET_BOUNDS_MS.length // overflow
}

/**
 * Record one sample (ms) into the histogram, in place. Non-finite values are
 * ignored (do not pollute count/sum). Negative values clamp into bucket 0 but
 * are still counted (a 0ms/negative measurement is a real, if degenerate, sample).
 */
export function recordValue(h: LatencyHistogram, valueMs: number): void {
  if (!Number.isFinite(valueMs)) return
  h.buckets[bucketIndexFor(valueMs)] += 1
  h.count += 1
  h.sum += valueMs
  // Track the real tail magnitude so an overflow percentile can report the true
  // ceiling instead of the clamp. Negatives never raise it (max stays ≥ 0).
  if (valueMs > (h.max ?? 0)) h.max = valueMs
}

/**
 * Merge `src` into `dst` in place (additive). Both must share the bucket layout
 * (they always do — `emptyHistogram` is the only constructor). Returns `dst`.
 */
export function mergeInto(dst: LatencyHistogram, src: LatencyHistogram): LatencyHistogram {
  for (let i = 0; i < dst.buckets.length; i++) {
    dst.buckets[i] += src.buckets[i] ?? 0
  }
  dst.count += src.count
  dst.sum += src.sum
  // `max` is additive under `Math.max`, so a range view keeps the true tail.
  dst.max = Math.max(dst.max ?? 0, src.max ?? 0)
  return dst
}

/** Merge any number of histograms into a fresh one (additive, non-mutating). */
export function mergeHistograms(...hs: LatencyHistogram[]): LatencyHistogram {
  const out = emptyHistogram()
  for (const h of hs) mergeInto(out, h)
  return out
}

/**
 * Derive the p-th percentile (p in [0, 100]) in ms, or `null` for an empty
 * histogram. Linear interpolation within the bucket holding the target rank
 * (Prometheus `histogram_quantile` semantics). The overflow bucket has no upper
 * bound, so a percentile landing there returns its lower bound (the last
 * boundary) — a conservative under-estimate, flagged by the caller via
 * `overflowCount` if needed.
 */
export function percentile(h: LatencyHistogram, p: number): number | null {
  if (h.count <= 0) return null
  const clamped = Math.min(100, Math.max(0, p))
  const rank = (clamped / 100) * h.count

  let cumulative = 0
  for (let i = 0; i < h.buckets.length; i++) {
    const bucketCount = h.buckets[i]
    cumulative += bucketCount
    if (cumulative >= rank && bucketCount > 0) {
      const lower = i === 0 ? 0 : LATENCY_BUCKET_BOUNDS_MS[i - 1]
      // Overflow bucket: no upper bound → return its lower edge.
      if (i >= LATENCY_BUCKET_BOUNDS_MS.length) return lower
      const upper = LATENCY_BUCKET_BOUNDS_MS[i]
      const countBefore = cumulative - bucketCount
      const fractionIntoBucket = (rank - countBefore) / bucketCount
      return lower + (upper - lower) * fractionIntoBucket
    }
  }
  // Unreachable when count > 0, but stay total: last finite boundary.
  return LATENCY_BUCKET_BOUNDS_MS[LATENCY_BUCKET_BOUNDS_MS.length - 1]
}

/** Arithmetic mean (ms), or `null` for an empty histogram. */
export function mean(h: LatencyHistogram): number | null {
  return h.count > 0 ? h.sum / h.count : null
}

/** Count of samples in the overflow bucket `(lastBound, +inf)` — fuels a "capped" hint in the UI. */
export function overflowCount(h: LatencyHistogram): number {
  return h.buckets[OVERFLOW_BUCKET_INDEX] ?? 0
}

/**
 * Index of the bucket that holds the p-th percentile's rank, or `null` for an
 * empty histogram. Same rank-walk as `percentile` but returns the bucket rather
 * than the interpolated value — lets the caller detect when a percentile lands
 * in the unbounded overflow bucket (`=== OVERFLOW_BUCKET_INDEX`), i.e. is capped.
 */
export function percentileBucketIndex(h: LatencyHistogram, p: number): number | null {
  if (h.count <= 0) return null
  const rank = (Math.min(100, Math.max(0, p)) / 100) * h.count
  let cumulative = 0
  for (let i = 0; i < h.buckets.length; i++) {
    cumulative += h.buckets[i]
    if (cumulative >= rank && h.buckets[i] > 0) return i
  }
  return h.buckets.length - 1
}

/**
 * Convenience: derive the canonical percentile set used by the admin window.
 * `null` fields when the histogram is empty.
 */
export function summarize(h: LatencyHistogram): {
  count: number
  p50: number | null
  p95: number | null
  p99: number | null
  mean: number | null
  /**
   * Per-bucket counts (copy), aligned to `LATENCY_BUCKET_BOUNDS_MS` with a
   * trailing overflow bucket. Lets the frontend render the distribution as a
   * heatmap (TER-616/R7.1) without re-deriving it from percentiles. Additive.
   */
  buckets: number[]
  /** Samples above the last finite bound `(81920ms, +inf)`. `>0` ⇒ a capped tail. */
  overflowCount: number
  /** Largest sample observed (ms), or `null` for an empty histogram — the true tail ceiling. */
  max: number | null
  /**
   * `true` when p99's rank lands in the unbounded overflow bucket → `p99` is a
   * lower-bound clamp (`81920ms`), not the real figure. The UI renders "≥81.9s".
   * TER-674/A3.1.
   */
  p99Capped: boolean
} {
  return {
    count: h.count,
    p50: percentile(h, 50),
    p95: percentile(h, 95),
    p99: percentile(h, 99),
    mean: mean(h),
    buckets: [...h.buckets],
    overflowCount: overflowCount(h),
    max: h.count > 0 ? (h.max ?? 0) : null,
    p99Capped: percentileBucketIndex(h, 99) === OVERFLOW_BUCKET_INDEX,
  }
}
