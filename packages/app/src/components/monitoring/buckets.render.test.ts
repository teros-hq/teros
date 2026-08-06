/**
 * Pure tests for the time-bucket helpers (P5/P7 of the 2026-07-07 audit).
 * Exact payloads: the aggregation collapses (bucket × groupKey) rows into one
 * point per time bucket; the fill produces a uniform axis; the delta splits by
 * TIME, not by row count.
 */

import { describe, expect, it } from "vitest"
import type { AgentUsageBucket } from "../../services/AdminApi"
import {
  aggregateBucketsByTime,
  bucketLabel,
  fillSeriesBuckets,
  fillTimeBuckets,
  filterBucketsByProvider,
  providerCountsFromBuckets,
  pctDeltaOverTime,
  unitForPeriodMs,
} from "./buckets"

const H16 = "2026-07-07T16:00:00.000Z"
const H17 = "2026-07-07T17:00:00.000Z"

function row(bucket: string, over: Partial<AgentUsageBucket> = {}): AgentUsageBucket {
  return {
    bucket,
    groupKey: { userId: "u1", agentId: "a1", provider: "teros", workspaceId: "w1" },
    inputTokens: 100,
    outputTokens: 10,
    cachedReadTokens: 5,
    totalTokens: 110,
    costUsd: 0.5,
    activeMs: 60_000,
    activeHours: 1 / 60,
    sessionCount: 2,
    tokensPerActiveHour: null,
    ...over,
  }
}

describe("aggregateBucketsByTime", () => {
  it("collapses several groupKey rows of the SAME hour into one exact point", () => {
    const out = aggregateBucketsByTime([
      row(H16),
      row(H16, { groupKey: { userId: "u2" }, inputTokens: 50, outputTokens: 5, cachedReadTokens: 0, totalTokens: 55, costUsd: 0.25, activeHours: 0.5, sessionCount: 3 }),
      row(H17, { inputTokens: 7, outputTokens: 3, cachedReadTokens: 1, totalTokens: 10, costUsd: 0.1, activeHours: 0.1, sessionCount: 1 }),
    ])
    expect(out).toEqual([
      {
        bucket: H16,
        inputTokens: 150,
        outputTokens: 15,
        cachedReadTokens: 5,
        totalTokens: 165,
        costUsd: 0.75,
        activeHours: 1 / 60 + 0.5,
        sessionCount: 5,
      },
      {
        bucket: H17,
        inputTokens: 7,
        outputTokens: 3,
        cachedReadTokens: 1,
        totalTokens: 10,
        costUsd: 0.1,
        activeHours: 0.1,
        sessionCount: 1,
      },
    ])
  })

  it("sorts by bucket regardless of input order", () => {
    const out = aggregateBucketsByTime([row(H17), row(H16)])
    expect(out.map((p) => p.bucket)).toEqual([H16, H17])
  })
})

describe("fillTimeBuckets", () => {
  it("zero-fills the missing hours so the axis is uniform", () => {
    const agg = aggregateBucketsByTime([row(H16)])
    const out = fillTimeBuckets(agg, "2026-07-07T15:00:00.000Z", "2026-07-07T18:00:00.000Z", "hour")
    expect(out.map((p) => [p.bucket, p.sessionCount])).toEqual([
      ["2026-07-07T15:00:00.000Z", 0],
      [H16, 2],
      [H17, 0],
    ])
  })

  it("aligns a mid-hour `from` to the bucket grid (the rollup bucket of a 16:40 `from` is 16:00)", () => {
    const out = fillTimeBuckets([], "2026-07-07T15:40:00.000Z", "2026-07-07T17:10:00.000Z", "hour")
    expect(out.map((p) => p.bucket)).toEqual([
      "2026-07-07T15:00:00.000Z",
      H16,
      H17,
    ])
  })

  it("day unit fills per UTC day", () => {
    const out = fillTimeBuckets([], "2026-07-05T10:00:00.000Z", "2026-07-07T10:00:00.000Z", "day")
    expect(out.map((p) => p.bucket)).toEqual([
      "2026-07-05T00:00:00.000Z",
      "2026-07-06T00:00:00.000Z",
      "2026-07-07T00:00:00.000Z",
    ])
  })
})

describe("fillSeriesBuckets", () => {
  it("zero-fills a model-health-like series with caller-shaped empties", () => {
    const series = [{ hourBucket: H16, models: ["m"] }]
    const out = fillSeriesBuckets(
      series,
      "2026-07-07T15:00:00.000Z",
      "2026-07-07T18:00:00.000Z",
      "hour",
      (iso) => ({ hourBucket: iso, models: [] as string[] }),
    )
    expect(out).toEqual([
      { hourBucket: "2026-07-07T15:00:00.000Z", models: [] },
      { hourBucket: H16, models: ["m"] },
      { hourBucket: H17, models: [] },
    ])
  })
})

describe("pctDeltaOverTime", () => {
  it("compares the halves of the series by TIME (2nd half vs 1st)", () => {
    expect(pctDeltaOverTime([10, 10, 20, 20])).toEqual({ text: "▲ 100%", up: true })
    expect(pctDeltaOverTime([20, 20, 10, 10])).toEqual({ text: "▼ 50%", up: false })
  })
  it("needs at least 4 points to claim a trend", () => {
    expect(pctDeltaOverTime([1, 100, 100])).toBeNull()
  })
  it("all-zero first half with activity after reads as new", () => {
    expect(pctDeltaOverTime([0, 0, 5, 5])).toEqual({ text: "▲ new", up: true })
  })
})

describe("unitForPeriodMs / bucketLabel", () => {
  it("1h/24h stay hourly, 7d/30d switch to daily", () => {
    expect(unitForPeriodMs(3_600_000)).toBe("hour")
    expect(unitForPeriodMs(86_400_000)).toBe("hour")
    expect(unitForPeriodMs(7 * 86_400_000)).toBe("day")
    expect(unitForPeriodMs(30 * 86_400_000)).toBe("day")
  })

  it("labels carry the date for day buckets and for multi-day hourly spans", () => {
    expect(bucketLabel("2026-07-07T16:00:00.000Z", "day", false)).toBe("Jul 7")
    expect(bucketLabel("2026-07-07T16:00:00.000Z", "hour", true)).toMatch(/^Jul 7 \d{2}:\d{2}$/)
    expect(bucketLabel("2026-07-07T16:00:00.000Z", "hour", false)).toMatch(/^\d{2}:\d{2}$/)
  })
})

describe("providerCountsFromBuckets / filterBucketsByProvider (P4)", () => {
  it("chips carry the LOGICAL provider with summed session counts, sorted desc", () => {
    const rows = [
      row(H16), // teros, 2 sessions
      row(H17, { groupKey: { provider: "teros" }, sessionCount: 3 }),
      row(H16, { groupKey: { provider: "anthropic" }, sessionCount: 4 }),
      row(H16, { groupKey: {} , sessionCount: 9 }), // no provider → skipped, never a chip
    ]
    expect(providerCountsFromBuckets(rows)).toEqual([
      ["teros", 5],
      ["anthropic", 4],
    ])
  })

  it("filterBucketsByProvider scopes by groupKey.provider exactly; undefined passes through", () => {
    const rows = [row(H16), row(H16, { groupKey: { provider: "anthropic" }, sessionCount: 4 })]
    expect(filterBucketsByProvider(rows, "teros")).toEqual([rows[0]])
    expect(filterBucketsByProvider(rows, undefined)).toBe(rows)
  })
})
