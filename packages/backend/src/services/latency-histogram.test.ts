/**
 * Tests for the additive latency histogram (TER-616 / F1).
 *
 * The acceptance criterion calls out "mutation-test del cómputo de percentiles
 * (merge de histogramas correcto)". Percentiles are derived by linear
 * interpolation inside the bucket holding the target rank (Prometheus
 * histogram_quantile), so the values below are computed by hand and asserted
 * exactly — a mutated interpolation or bucket-boundary breaks them.
 */

import { describe, expect, it } from "bun:test"
import {
  bucketIndexFor,
  emptyHistogram,
  LATENCY_BUCKET_BOUNDS_MS,
  type LatencyHistogram,
  mean,
  mergeHistograms,
  mergeInto,
  OVERFLOW_BUCKET_INDEX,
  overflowCount,
  percentile,
  percentileBucketIndex,
  recordValue,
  summarize,
} from "./latency-histogram"

function histOf(values: number[]): LatencyHistogram {
  const h = emptyHistogram()
  for (const v of values) recordValue(h, v)
  return h
}

describe("bucketIndexFor — boundaries (inclusive upper bound)", () => {
  it("clamps 0 and negatives into bucket 0", () => {
    expect(bucketIndexFor(0)).toBe(0)
    expect(bucketIndexFor(-5)).toBe(0)
  })

  it("places a value EQUAL to a bound in that bound's bucket (<=)", () => {
    expect(bucketIndexFor(10)).toBe(0) // 10 <= bound[0]=10
    expect(bucketIndexFor(20)).toBe(1) // 20 <= bound[1]=20
    expect(bucketIndexFor(81920)).toBe(13) // last finite bound
  })

  it("places a value just above a bound in the next bucket", () => {
    expect(bucketIndexFor(10.0001)).toBe(1)
    expect(bucketIndexFor(21)).toBe(2)
  })

  it("places values above the last bound in the overflow bucket", () => {
    expect(bucketIndexFor(100000)).toBe(LATENCY_BUCKET_BOUNDS_MS.length) // 14
  })
})

describe("recordValue — counting and non-finite guard", () => {
  it("counts samples and accumulates sum", () => {
    const h = histOf([5, 15, 25])
    expect(h.count).toBe(3)
    expect(h.sum).toBe(45)
    expect(h.buckets[0]).toBe(1) // 5 → bucket 0
    expect(h.buckets[1]).toBe(1) // 15 → bucket 1
    expect(h.buckets[2]).toBe(1) // 25 → bucket 2
  })

  it("ignores NaN/Infinity without polluting count or sum", () => {
    const h = histOf([10, Number.NaN, Number.POSITIVE_INFINITY, 10])
    expect(h.count).toBe(2)
    expect(h.sum).toBe(20)
  })
})

describe("mergeInto / mergeHistograms — additive", () => {
  it("sums bucket counts, count and sum", () => {
    const a = histOf([5, 5]) // bucket 0 ×2
    const b = histOf([15, 25]) // bucket 1, bucket 2
    const merged = mergeHistograms(a, b)
    expect(merged.count).toBe(4)
    expect(merged.sum).toBe(50)
    expect(merged.buckets[0]).toBe(2)
    expect(merged.buckets[1]).toBe(1)
    expect(merged.buckets[2]).toBe(1)
  })

  it("mergeHistograms does NOT mutate its inputs", () => {
    const a = histOf([5])
    const b = histOf([15])
    mergeHistograms(a, b)
    expect(a.count).toBe(1)
    expect(a.buckets[1]).toBe(0)
    expect(b.count).toBe(1)
    expect(b.buckets[0]).toBe(0)
  })

  it("mergeInto mutates the destination and returns it", () => {
    const dst = histOf([5])
    const src = histOf([5, 15])
    const ret = mergeInto(dst, src)
    expect(ret).toBe(dst)
    expect(dst.count).toBe(3)
    expect(dst.buckets[0]).toBe(2)
    expect(dst.buckets[1]).toBe(1)
  })

  it("merging hourly histograms equals recording all samples at once (additivity invariant)", () => {
    const hour1 = histOf([5, 15, 15, 35])
    const hour2 = histOf([5, 75, 200])
    const merged = mergeHistograms(hour1, hour2)
    const allAtOnce = histOf([5, 15, 15, 35, 5, 75, 200])
    expect(merged.buckets).toEqual(allAtOnce.buckets)
    expect(merged.count).toBe(allAtOnce.count)
    expect(merged.sum).toBe(allAtOnce.sum)
  })
})

describe("percentile — exact interpolation (hand-computed)", () => {
  it("returns null for an empty histogram", () => {
    expect(percentile(emptyHistogram(), 95)).toBeNull()
  })

  it("interpolates within a single bucket", () => {
    // 10 samples all in bucket 0 (lower=0, upper=10). rank(p50)=5 →
    // 0 + 10 * (5/10) = 5.
    const h = emptyHistogram()
    for (let i = 0; i < 10; i++) recordValue(h, 3) // value irrelevant, bucket 0
    expect(percentile(h, 50)).toBe(5)
    // p100 → rank 10, full bucket → 0 + 10 * (10/10) = 10.
    expect(percentile(h, 100)).toBe(10)
  })

  it("interpolates across two buckets (p50 at the boundary, p90 inside bucket 1)", () => {
    // 5 samples bucket0 (≤10) + 5 samples bucket1 (10–20). count=10.
    const h = histOf([3, 3, 3, 3, 3, 15, 15, 15, 15, 15])
    // p50: rank=5; cumulative bucket0=5≥5 → bucket0, 0+10*(5/5)=10.
    expect(percentile(h, 50)).toBe(10)
    // p90: rank=9; bucket0=5<9, +bucket1=10≥9 → bucket1, lower=10,upper=20,
    // countBefore=5 → 10 + 10*((9-5)/5) = 10 + 8 = 18.
    expect(percentile(h, 90)).toBe(18)
  })

  it("returns the lower edge for a percentile landing in the overflow bucket", () => {
    // All samples above the last bound (81920) → overflow. p99 → lower edge 81920.
    const h = histOf([200000, 300000, 400000])
    expect(percentile(h, 99)).toBe(81920)
  })

  it("clamps p outside [0,100]", () => {
    const h = histOf([3, 3, 3, 3])
    expect(percentile(h, -10)).toBe(percentile(h, 0))
    expect(percentile(h, 150)).toBe(percentile(h, 100))
  })
})

describe("mean / overflowCount / summarize", () => {
  it("mean is sum/count, null when empty", () => {
    expect(mean(histOf([10, 20, 30]))).toBe(20)
    expect(mean(emptyHistogram())).toBeNull()
  })

  it("overflowCount counts only the overflow bucket", () => {
    const h = histOf([5, 200000, 300000])
    expect(overflowCount(h)).toBe(2)
  })

  it("summarize returns the canonical percentile set", () => {
    const h = histOf([3, 3, 3, 3, 3, 15, 15, 15, 15, 15])
    const s = summarize(h)
    expect(s.count).toBe(10)
    expect(s.p50).toBe(10)
    expect(s.mean).toBe(9) // (5*3 + 5*15)/10 = 90/10
    expect(s.p95).not.toBeNull()
    expect(s.p99).not.toBeNull()
  })

  it("summarize on empty → null percentiles, 0 count, zeroed buckets", () => {
    const s = summarize(emptyHistogram())
    expect(s).toEqual({
      count: 0,
      p50: null,
      p95: null,
      p99: null,
      mean: null,
      buckets: new Array(LATENCY_BUCKET_BOUNDS_MS.length + 1).fill(0),
      overflowCount: 0,
      max: null,
      p99Capped: false,
    })
  })
})

describe("max — additive tail ceiling (A3.1/TER-674)", () => {
  it("tracks the largest sample, 0 on empty", () => {
    expect(emptyHistogram().max).toBe(0)
    // 300000ms lands in overflow but max keeps the real magnitude, not the clamp.
    expect(histOf([5, 300000, 42598]).max).toBe(300000)
  })

  it("negatives never raise max (stays ≥ 0)", () => {
    expect(histOf([-100, 5]).max).toBe(5)
  })

  it("mergeInto keeps the larger max (Math.max, not sum)", () => {
    const a = histOf([100000])
    const b = histOf([250000])
    mergeInto(a, b)
    expect(a.max).toBe(250000) // NOT 350000 — max is additive under Math.max
  })

  it("summarize exposes max (real ceiling) even when p99 clamps to overflow", () => {
    const s = summarize(histOf([5, 10, 300000])) // 1/3 in overflow
    expect(s.max).toBe(300000)
    expect(s.overflowCount).toBe(1)
  })
})

describe("p99Capped — overflow clamp detection (A3.1/TER-674)", () => {
  it("percentileBucketIndex returns the overflow index for a tail percentile", () => {
    // 3 samples, p99 rank = 2.97 → lands in the 3rd (overflow) bucket.
    const h = histOf([5, 5, 300000])
    expect(percentileBucketIndex(h, 99)).toBe(OVERFLOW_BUCKET_INDEX)
    expect(percentileBucketIndex(h, 50)).toBe(0) // p50 in bucket 0
  })

  it("summarize flags p99Capped and returns the clamp (81920) as p99", () => {
    const h = histOf([5, 5, 300000])
    const s = summarize(h)
    expect(s.p99Capped).toBe(true)
    expect(s.p99).toBe(81920) // lower bound of overflow — a clamp, hence the flag
  })

  it("p99Capped is false when no sample overflows (real p99 within bounds)", () => {
    // Reproduce the audit ground-truth: real kimi tail p99 42.6s, 0 in overflow.
    const h = histOf([5500, 32000, 42598])
    const s = summarize(h)
    expect(s.p99Capped).toBe(false)
    expect(s.overflowCount).toBe(0)
    expect(s.p99).not.toBeNull()
    expect(s.p99 ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      LATENCY_BUCKET_BOUNDS_MS[LATENCY_BUCKET_BOUNDS_MS.length - 1],
    )
  })

  it("percentileBucketIndex is null on an empty histogram", () => {
    expect(percentileBucketIndex(emptyHistogram(), 99)).toBeNull()
  })
})
