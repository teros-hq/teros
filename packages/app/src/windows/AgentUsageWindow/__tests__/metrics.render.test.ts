/**
 * Characterization tests for the agent-usage dashboard pure computations.
 *
 * Covers `metrics.ts`: aggregateBuckets, computeKpiSparklines,
 * computeTrendPct, splitHalfTrend, computeKpiTrends.
 *
 * Goal — freeze the current behavior so a refactor of `AgentUsageWindow`
 * surfaces any divergence immediately. The math is straightforward; the
 * value of this suite is to catch silent regressions in the rollup logic
 * (sparkline timestamp grouping, trend null-guards, NaN propagation).
 */

import { describe, expect, it } from "vitest"
import {
  aggregateBuckets,
  computeKpiSparklines,
  computeKpiTrends,
  computeTrendPct,
  splitHalfTrend,
} from "../metrics"

// =============================================================================
// aggregateBuckets
// =============================================================================

describe("aggregateBuckets", () => {
  it("empty array returns zeros", () => {
    expect(aggregateBuckets([])).toEqual({
      sessions: 0,
      tokens: 0,
      costUsd: 0,
      activeHours: 0,
    })
  })

  it("single bucket passes values through", () => {
    expect(
      aggregateBuckets([
        {
          bucket: "2026-05-26T00:00:00.000Z",
          sessionCount: 5,
          totalTokens: 1000,
          costUsd: 1.5,
          activeHours: 0.25,
        } as any,
      ]),
    ).toEqual({
      sessions: 5,
      tokens: 1000,
      costUsd: 1.5,
      activeHours: 0.25,
    })
  })

  it("sums N buckets — exact integer fields and tolerated floats", () => {
    const buckets = [
      { sessionCount: 1, totalTokens: 100, costUsd: 0.1, activeHours: 0.5 },
      { sessionCount: 2, totalTokens: 200, costUsd: 0.2, activeHours: 1.0 },
      { sessionCount: 3, totalTokens: 300, costUsd: 0.3, activeHours: 1.5 },
    ]
    const result = aggregateBuckets(buckets as any)
    expect(result.sessions).toBe(6)
    expect(result.tokens).toBe(600)
    expect(result.activeHours).toBe(3)
    expect(result.costUsd).toBeCloseTo(0.6, 9)
  })

  it("treats missing optional fields as 0", () => {
    expect(
      aggregateBuckets([{ bucket: "x" } as any, { bucket: "y", totalTokens: 50 } as any]),
    ).toEqual({
      sessions: 0,
      tokens: 50,
      costUsd: 0,
      activeHours: 0,
    })
  })
})

// =============================================================================
// computeKpiSparklines
// =============================================================================

describe("computeKpiSparklines", () => {
  it("returns null for empty buckets", () => {
    expect(computeKpiSparklines([])).toBeNull()
  })

  it("returns null for a single bucket (no signal)", () => {
    expect(
      computeKpiSparklines([
        { bucket: "2026-05-26T00:00:00.000Z", sessionCount: 1 } as any,
      ]),
    ).toBeNull()
  })

  it("orders distinct timestamps oldest → newest", () => {
    const result = computeKpiSparklines([
      { bucket: "2026-05-26T02:00:00.000Z", sessionCount: 30, totalTokens: 300 } as any,
      { bucket: "2026-05-26T00:00:00.000Z", sessionCount: 10, totalTokens: 100 } as any,
      { bucket: "2026-05-26T01:00:00.000Z", sessionCount: 20, totalTokens: 200 } as any,
    ])
    expect(result).not.toBeNull()
    expect(result!.sessions).toEqual([10, 20, 30])
    expect(result!.tokens).toEqual([100, 200, 300])
  })

  it("aggregates duplicate timestamps from multiple agents/users", () => {
    // Same bucket time appears twice (e.g., two agents in the same hour).
    const result = computeKpiSparklines([
      {
        bucket: "2026-05-26T00:00:00.000Z",
        sessionCount: 5,
        totalTokens: 500,
        costUsd: 1.5,
        activeHours: 0.5,
      } as any,
      {
        bucket: "2026-05-26T00:00:00.000Z",
        sessionCount: 3,
        totalTokens: 200,
        costUsd: 0.5,
        activeHours: 0.25,
      } as any,
      {
        bucket: "2026-05-26T01:00:00.000Z",
        sessionCount: 4,
        totalTokens: 400,
        costUsd: 1.0,
        activeHours: 0.4,
      } as any,
    ])
    expect(result).not.toBeNull()
    expect(result!.sessions).toEqual([8, 4]) // [5+3, 4]
    expect(result!.tokens).toEqual([700, 400])
    expect(result!.cost).toEqual([2.0, 1.0])
    expect(result!.hours).toEqual([0.75, 0.4])
  })

  it("treats missing numeric fields as 0", () => {
    const result = computeKpiSparklines([
      { bucket: "2026-05-26T00:00:00.000Z" } as any,
      { bucket: "2026-05-26T01:00:00.000Z", totalTokens: 100 } as any,
    ])
    expect(result!.sessions).toEqual([0, 0])
    expect(result!.tokens).toEqual([0, 100])
    expect(result!.cost).toEqual([0, 0])
    expect(result!.hours).toEqual([0, 0])
  })
})

// =============================================================================
// computeTrendPct
// =============================================================================

describe("computeTrendPct", () => {
  it("returns null when previous is 0 (divide-by-zero guard)", () => {
    expect(computeTrendPct(10, 0)).toBeNull()
    expect(computeTrendPct(0, 0)).toBeNull()
  })

  it("returns null when either input is non-finite", () => {
    expect(computeTrendPct(Number.NaN, 10)).toBeNull()
    expect(computeTrendPct(10, Number.NaN)).toBeNull()
    expect(computeTrendPct(Number.POSITIVE_INFINITY, 10)).toBeNull()
    expect(computeTrendPct(10, Number.NEGATIVE_INFINITY)).toBeNull()
  })

  it("positive delta as %", () => {
    expect(computeTrendPct(150, 100)).toBe(50)
    expect(computeTrendPct(120, 100)).toBe(20)
  })

  it("negative delta as %", () => {
    expect(computeTrendPct(80, 100)).toBe(-20)
    expect(computeTrendPct(50, 100)).toBe(-50)
  })

  it("zero delta", () => {
    expect(computeTrendPct(100, 100)).toBe(0)
  })

  it("uses absolute value of previous as denominator", () => {
    // current=+10, previous=-10 → delta=+20, denom=|-10|=10 → +200%
    expect(computeTrendPct(10, -10)).toBe(200)
  })
})

// =============================================================================
// splitHalfTrend
// =============================================================================

describe("splitHalfTrend", () => {
  it("returns null for series <2 points", () => {
    expect(splitHalfTrend([])).toBeNull()
    expect(splitHalfTrend([1])).toBeNull()
  })

  it("2-point series: second-half (1 point) vs first-half (1 point)", () => {
    // mid = floor(2/2) = 1 → firstHalf = [a], secondHalf = [b]
    expect(splitHalfTrend([100, 150])).toBe(50)
    expect(splitHalfTrend([100, 50])).toBe(-50)
  })

  it("3-point series: mid=1 → first=[a], second=[b,c]", () => {
    expect(splitHalfTrend([100, 50, 50])).toBe(0) // first=100, second=100
    expect(splitHalfTrend([50, 100, 100])).toBe(300) // first=50, second=200 → +300%
  })

  it("4-point series: mid=2 → first=[a,b], second=[c,d]", () => {
    expect(splitHalfTrend([10, 10, 20, 20])).toBe(100) // first=20, second=40 → +100%
  })

  it("returns null when firstHalf sum is 0 (divide-by-zero)", () => {
    expect(splitHalfTrend([0, 0, 10, 10])).toBeNull()
  })
})

// =============================================================================
// computeKpiTrends
// =============================================================================

describe("computeKpiTrends", () => {
  it("null sparklines → null trends", () => {
    expect(computeKpiTrends(null)).toBeNull()
  })

  it("maps splitHalfTrend over each KPI series", () => {
    const result = computeKpiTrends({
      sessions: [10, 10, 20, 20], // +100%
      tokens: [100, 50, 50], // 0%
      cost: [], // null (empty)
      hours: [1, 2], // +100%
    })
    expect(result).toEqual({
      sessions: 100,
      tokens: 0,
      cost: null,
      hours: 100,
    })
  })
})
