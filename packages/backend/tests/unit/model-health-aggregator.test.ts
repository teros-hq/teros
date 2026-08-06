/**
 * Tests for the model-health aggregator (TER-616 / F1).
 *
 * Verifies the merge-then-derive contract: histograms from several hourly
 * rollups are summed (additive) and percentiles/rates are derived only AFTER
 * the merge. Also pins the C1 invariant: Fireworks and Together stay separate
 * even for the same model.
 */

import { describe, expect, it } from "bun:test"
import { emptyHistogram, recordValue } from "../../src/services/latency-histogram"
import {
  aggregateModelHealth,
  aggregateModelHealthByHour,
  applyThroughputToSummaries,
  applyThumbsToSummaries,
  buildModelHealthFromSessions,
  type ModelHealthSummary,
} from "../../src/services/model-health-aggregator"
import { RollupAccumulator } from "../../src/services/rollup-accumulator"
import type {
  AgentUsageRollupHourly,
  AgentUsageSession,
  ModelHealthEntry,
} from "../../src/types/database"

function makeSession(overrides: Partial<AgentUsageSession> = {}): AgentUsageSession {
  return {
    sessionUsageId: "usess_x",
    parentSessionUsageId: null,
    triggerKind: "user_message",
    userId: "user_1",
    agentId: "agent_1",
    workspaceId: "work_1",
    channelId: "ch_1",
    provider: "teros",
    modelId: "kimi",
    startedAt: new Date("2026-06-30T10:00:00Z"),
    endedAt: new Date("2026-06-30T10:00:10Z"),
    durationMs: 10_000,
    durationSource: "monotonic",
    status: "completed",
    inputTokens: 100,
    outputTokens: 50,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 150,
    costUsd: 0.01,
    descendantInputTokens: 0,
    descendantOutputTokens: 0,
    descendantCostUsd: 0,
    descendantSessionCount: 0,
    llmCallCount: 1,
    toolCallCount: 0,
    schemaVersion: 1,
    createdAt: new Date("2026-06-30T10:00:10Z"),
    updatedAt: new Date("2026-06-30T10:00:10Z"),
    ...overrides,
  } as AgentUsageSession
}

function entry(
  actualProvider: string,
  modelId: string,
  opts: {
    requestCount: number
    latencies?: number[]
    ttfts?: number[]
    statusCounts?: ModelHealthEntry["statusCounts"]
    errorCounts?: ModelHealthEntry["errorCounts"]
    finishReasons?: ModelHealthEntry["finishReasons"]
    emptyCount?: number
    fallbackCount?: number
    toolCallCount?: number
    toolErrorCount?: number
  },
): ModelHealthEntry {
  const latency = emptyHistogram()
  for (const l of opts.latencies ?? []) recordValue(latency, l)
  const ttft = emptyHistogram()
  for (const t of opts.ttfts ?? []) recordValue(ttft, t)
  return {
    actualProvider,
    modelId,
    requestCount: opts.requestCount,
    latency,
    ttft,
    statusCounts: opts.statusCounts ?? {},
    errorCounts: opts.errorCounts ?? {},
    finishReasons: opts.finishReasons,
    emptyCount: opts.emptyCount,
    fallbackCount: opts.fallbackCount,
    toolCallCount: opts.toolCallCount,
    toolErrorCount: opts.toolErrorCount,
  }
}

function rollup(...entries: ModelHealthEntry[]): Pick<AgentUsageRollupHourly, "modelHealth"> {
  const modelHealth: Record<string, ModelHealthEntry> = {}
  for (const e of entries) modelHealth[`${e.actualProvider}::${e.modelId}`] = e
  return { modelHealth }
}

describe("aggregateModelHealth (TER-616)", () => {
  it("merges the same upstream×model across hourly rollups (additive) then derives percentiles", () => {
    const r1 = rollup(
      entry("fireworks", "kimi", {
        requestCount: 2,
        latencies: [1200, 1200],
        statusCounts: { completed: 2 },
      }),
    )
    const r2 = rollup(
      entry("fireworks", "kimi", {
        requestCount: 3,
        latencies: [1200, 1200, 1200],
        statusCounts: { completed: 1, errored: 2 },
        errorCounts: { rate_limited: 2 },
      }),
    )
    const out = aggregateModelHealth([r1, r2])
    expect(out).toHaveLength(1)
    const s = out[0]!
    expect(s.actualProvider).toBe("fireworks")
    expect(s.requestCount).toBe(5)
    expect(s.latency.count).toBe(5)
    expect(s.statusCounts.completed).toBe(3)
    expect(s.statusCounts.errored).toBe(2)
    expect(s.errorCounts.rate_limited).toBe(2)
    expect(s.errorRate).toBe(2 / 5)
    expect(s.successRate).toBe(3 / 5)
    // 1200ms is in bucket (640, 1280] → p50 interpolates within it.
    expect(s.latency.p50!).toBeGreaterThan(640)
    expect(s.latency.p50!).toBeLessThanOrEqual(1280)
  })

  it("keeps Fireworks and Together separate for the same model (C1)", () => {
    const r = rollup(
      entry("fireworks", "kimi", { requestCount: 1, latencies: [2000] }),
      entry("together", "kimi", { requestCount: 1, latencies: [500] }),
    )
    const out = aggregateModelHealth([r])
    expect(out).toHaveLength(2)
    const fw = out.find((s) => s.actualProvider === "fireworks")!
    const tg = out.find((s) => s.actualProvider === "together")!
    // Fireworks served the slow turn → its p50 must be higher than Together's.
    expect(fw.latency.p50!).toBeGreaterThan(tg.latency.p50!)
  })

  it("sorts summaries by descending requestCount (busiest first)", () => {
    const r = rollup(
      entry("fireworks", "a", { requestCount: 1 }),
      entry("together", "b", { requestCount: 5 }),
    )
    const out = aggregateModelHealth([r])
    expect(out.map((s) => s.requestCount)).toEqual([5, 1])
  })

  it("skips rollups without a modelHealth block (legacy/pre-F1)", () => {
    expect(aggregateModelHealth([{}, { modelHealth: undefined }])).toEqual([])
  })

  it("merging two hours equals one hour with all samples (additivity at the summary level)", () => {
    const split = aggregateModelHealth([
      rollup(
        entry("fireworks", "m", {
          requestCount: 1,
          latencies: [100],
          statusCounts: { completed: 1 },
        }),
      ),
      rollup(
        entry("fireworks", "m", {
          requestCount: 1,
          latencies: [9000],
          statusCounts: { errored: 1 },
          errorCounts: { server_error: 1 },
        }),
      ),
    ])[0]!
    const whole = aggregateModelHealth([
      rollup(
        entry("fireworks", "m", {
          requestCount: 2,
          latencies: [100, 9000],
          statusCounts: { completed: 1, errored: 1 },
          errorCounts: { server_error: 1 },
        }),
      ),
    ])[0]!
    expect(split.requestCount).toBe(whole.requestCount)
    expect(split.latency).toEqual(whole.latency)
    expect(split.errorRate).toBe(whole.errorRate)
  })

  it("derives the §3.1/§2.1 quality + saturation + fallback rates (R3.5/R4/R6.2/R8.4)", () => {
    const s = aggregateModelHealth([
      rollup(
        entry("fireworks", "kimi", {
          requestCount: 10,
          statusCounts: { completed: 6, errored: 2, timed_out: 1, aborted: 1 },
          errorCounts: { rate_limited: 1, overloaded: 1 },
          finishReasons: { stop: 6, length: 2, tool_calls: 2 },
          emptyCount: 1,
          fallbackCount: 2,
          toolCallCount: 8,
          toolErrorCount: 2,
        }),
      ),
    ])[0]!
    // errorRate folds timeouts into the numerator (R8.4): (2 errored + 1 timed_out) / 10.
    expect(s.errorRate).toBe(3 / 10)
    // successRate excludes the user-aborted turn from the denominator (R8.4): 6 / 9.
    expect(s.successRate).toBe(6 / 9)
    expect(s.timeoutRate).toBe(1 / 10)
    expect(s.abortRate).toBe(1 / 10)
    // saturation = (rate_limited + overloaded) / requestCount (R6.2).
    expect(s.saturationRate).toBe(2 / 10)
    expect(s.fallbackRate).toBe(2 / 10)
    expect(s.emptyRate).toBe(1 / 10)
    // truncation = finishReasons.length / requestCount (§3.1).
    expect(s.truncationRate).toBe(2 / 10)
    // tool-error-rate is over tool EXECUTIONS, not turns (R4.3): 2 / 8.
    expect(s.toolErrorRate).toBe(2 / 8)
    expect(s.toolCallCount).toBe(8)
    expect(s.finishReasons.length).toBe(2)
  })

  it("merges finishReasons + tool counts additively across hours (R4)", () => {
    const r1 = rollup(
      entry("fireworks", "m", {
        requestCount: 3,
        finishReasons: { length: 1, stop: 2 },
        toolCallCount: 3,
        toolErrorCount: 1,
      }),
    )
    const r2 = rollup(
      entry("fireworks", "m", {
        requestCount: 3,
        finishReasons: { length: 2, stop: 1 },
        toolCallCount: 2,
        toolErrorCount: 1,
      }),
    )
    const s = aggregateModelHealth([r1, r2])[0]!
    expect(s.finishReasons.length).toBe(3)
    expect(s.finishReasons.stop).toBe(3)
    expect(s.truncationRate).toBe(3 / 6)
    expect(s.toolErrorRate).toBe(2 / 5)
    expect(s.toolCallCount).toBe(5)
  })

  it("toolErrorRate is 0 when no tools ran (no div-by-zero)", () => {
    const s = aggregateModelHealth([
      rollup(entry("fireworks", "m", { requestCount: 5, toolCallCount: 0, toolErrorCount: 0 })),
    ])[0]!
    expect(s.toolErrorRate).toBe(0)
  })

  it("legacy entries without the new fields yield zero rates + empty finishReasons (back-compat)", () => {
    const s = aggregateModelHealth([
      rollup(entry("fireworks", "m", { requestCount: 4, statusCounts: { completed: 4 } })),
    ])[0]!
    expect(s.fallbackRate).toBe(0)
    expect(s.emptyRate).toBe(0)
    expect(s.truncationRate).toBe(0)
    expect(s.toolErrorRate).toBe(0)
    expect(s.saturationRate).toBe(0)
    expect(s.finishReasons).toEqual({})
  })
})

describe("applyThumbsToSummaries (TER-616/R4.4)", () => {
  function summary(actualProvider: string, modelId: string): ModelHealthSummary {
    return { actualProvider, modelId } as ModelHealthSummary
  }

  it("merges thumbs by actualProvider::modelId (same key as the rollup)", () => {
    const summaries = [summary("fireworks", "kimi"), summary("together", "kimi")]
    applyThumbsToSummaries(summaries, { "fireworks::kimi": { up: 5, down: 2 } })
    expect(summaries[0]!.thumbsUp).toBe(5)
    expect(summaries[0]!.thumbsDown).toBe(2)
    // Same model on a DIFFERENT upstream must NOT inherit the tally (C1).
    expect(summaries[1]!.thumbsUp).toBe(0)
    expect(summaries[1]!.thumbsDown).toBe(0)
  })

  it("defaults to 0/0 when there is no feedback (widget shows 0, not missing)", () => {
    const summaries = [summary("fireworks", "kimi")]
    applyThumbsToSummaries(summaries, {})
    expect(summaries[0]!.thumbsUp).toBe(0)
    expect(summaries[0]!.thumbsDown).toBe(0)
  })
})

describe("applyThroughputToSummaries (F1.1)", () => {
  function summary(actualProvider: string, requestCount: number): ModelHealthSummary {
    return { actualProvider, modelId: "m", requestCount } as ModelHealthSummary
  }

  it("derives requestCount / periodMinutes (turns per minute over the window)", () => {
    const summaries = [summary("fireworks", 120), summary("together", 30)]
    applyThroughputToSummaries(summaries, 60) // a 1-hour window
    // 120 turns over 60 min = 2/min; 30 over 60 = 0.5/min. Exact, not "≈".
    expect(summaries[0]!.throughputPerMin).toBe(2)
    expect(summaries[1]!.throughputPerMin).toBe(0.5)
  })

  it("guards a non-positive period (0 → 0, never Infinity/NaN)", () => {
    const s = [summary("fireworks", 100)]
    applyThroughputToSummaries(s, 0)
    expect(s[0]!.throughputPerMin).toBe(0)
    expect(Number.isFinite(s[0]!.throughputPerMin!)).toBe(true)
  })

  it("a zero-request model has zero throughput (not a division artefact)", () => {
    const s = [summary("fireworks", 0)]
    applyThroughputToSummaries(s, 1440)
    expect(s[0]!.throughputPerMin).toBe(0)
  })
})

describe("aggregateModelHealthByHour (F1.2)", () => {
  function entryAt(modelId: string, requestCount: number): ModelHealthEntry {
    return entry("fireworks", modelId, { requestCount, statusCounts: { completed: requestCount } })
  }
  function rollupAt(
    hourBucket: Date,
    ...entries: ModelHealthEntry[]
  ): Pick<AgentUsageRollupHourly, "hourBucket" | "modelHealth"> {
    return { hourBucket, ...rollup(...entries) }
  }
  const h0 = new Date("2026-06-30T10:00:00.000Z")
  const h1 = new Date("2026-06-30T11:00:00.000Z")
  const h2 = new Date("2026-06-30T12:00:00.000Z")

  it("keeps each hour separate — does NOT merge across hours", () => {
    const series = aggregateModelHealthByHour([
      rollupAt(h1, entryAt("kimi", 3)),
      rollupAt(h0, entryAt("kimi", 1)),
    ])
    expect(series).toHaveLength(2)
    // Each bucket carries only its own hour's volume (no collapse into one).
    expect(series[0]!.models[0]!.requestCount).toBe(1)
    expect(series[1]!.models[0]!.requestCount).toBe(3)
  })

  it("returns buckets in ascending chronological order regardless of input order", () => {
    const series = aggregateModelHealthByHour([
      rollupAt(h2, entryAt("kimi", 1)),
      rollupAt(h0, entryAt("kimi", 1)),
      rollupAt(h1, entryAt("kimi", 1)),
    ])
    expect(series.map((s) => s.hourBucket.toISOString())).toEqual([
      h0.toISOString(),
      h1.toISOString(),
      h2.toISOString(),
    ])
  })

  it("aggregates rollups that share an hour together (different group keys, same bucket)", () => {
    // Two rollups in the SAME hour (e.g. two agents) → one bucket, merged.
    const series = aggregateModelHealthByHour([
      rollupAt(h0, entryAt("kimi", 2)),
      rollupAt(h0, entryAt("kimi", 5)),
    ])
    expect(series).toHaveLength(1)
    expect(series[0]!.models[0]!.requestCount).toBe(7)
  })

  it("skips rollups without a modelHealth block, yielding an empty bucket", () => {
    const series = aggregateModelHealthByHour([{ hourBucket: h0, modelHealth: undefined }])
    expect(series).toHaveLength(1)
    expect(series[0]!.models).toEqual([])
  })

  // ── bucketUnit (P5, 2026-07-07 monitoring audit) ──────────────────────────

  it("bucketUnit 'day' merges the hours of one UTC day into a single midnight bucket", () => {
    const otherDay = new Date("2026-07-01T09:00:00.000Z")
    const series = aggregateModelHealthByHour(
      [rollupAt(h0, entryAt("kimi", 2)), rollupAt(h1, entryAt("kimi", 5)), rollupAt(otherDay, entryAt("kimi", 1))],
      "day",
    )
    expect(series.map((s) => s.hourBucket.toISOString())).toEqual([
      "2026-06-30T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
    ])
    expect(series[0]!.models[0]!.requestCount).toBe(7)
    expect(series[1]!.models[0]!.requestCount).toBe(1)
  })

  it("bucketUnit 'day' merges histograms BEFORE deriving percentiles (exact, not averaged)", () => {
    const morning = rollupAt(h0, entry("fireworks", "kimi", { requestCount: 3, latencies: [100, 100, 100] }))
    const evening = rollupAt(h1, entry("fireworks", "kimi", { requestCount: 1, latencies: [10_000] }))
    const [day] = aggregateModelHealthByHour([morning, evening], "day")
    // p50 over the merged {100,100,100,10000} histogram sits in the fast bucket;
    // an average of hourly p50s (100 vs 10000) would have inflated it.
    expect(day!.models[0]!.latency.count).toBe(4)
    expect(day!.models[0]!.latency.p50!).toBeLessThan(1_000)
  })

  it("bucketUnit defaults to 'hour' (existing behavior unchanged)", () => {
    const series = aggregateModelHealthByHour([rollupAt(h0, entryAt("kimi", 2)), rollupAt(h1, entryAt("kimi", 5))])
    expect(series).toHaveLength(2)
  })
})

describe("subReasonCounts fold (TER-698/TER-700 — honest attribution)", () => {
  it("folds errorSubReason on errored sessions; exposes it in the entry + summary", () => {
    const mh = buildModelHealthFromSessions([
      makeSession({
        status: "errored",
        errorKind: "rate_limited",
        errorSubReason: "provider_capacity",
      }),
      makeSession({
        status: "errored",
        errorKind: "rate_limited",
        errorSubReason: "provider_capacity",
      }),
      makeSession({
        status: "errored",
        errorKind: "spend_gate",
        errorSubReason: "provider_billing",
      }),
      makeSession({ status: "completed" }), // no sub-reason
    ])
    // Mutation: drop the `entry.subReasonCounts[...]` fold in accumulate → red.
    expect(mh["teros::kimi"]!.subReasonCounts).toEqual({
      provider_capacity: 2,
      provider_billing: 1,
    })
    const summary = aggregateModelHealth([{ modelHealth: mh }])[0]!
    expect(summary.subReasonCounts).toEqual({ provider_capacity: 2, provider_billing: 1 })
  })

  it("records no sub-reason for a legacy errored turn, and merges classified ones across rollups", () => {
    const a = buildModelHealthFromSessions([
      makeSession({
        status: "errored",
        errorKind: "rate_limited",
        errorSubReason: "provider_capacity",
      }),
    ])
    const b = buildModelHealthFromSessions([
      makeSession({ status: "errored", errorKind: "rate_limited" }), // legacy: no sub-reason
    ])
    const summary = aggregateModelHealth([{ modelHealth: a }, { modelHealth: b }])[0]!
    // Two errored turns, one classified — the Mongo-style merge sums the classified one only.
    expect(summary.subReasonCounts).toEqual({ provider_capacity: 1 })
    // errorCounts still counts BOTH (the coarse bucket is unaffected).
    expect(summary.errorCounts.rate_limited).toBe(2)
  })
})

describe("buildModelHealthFromSessions (TER-645/#2 — live in-progress hour)", () => {
  it("folds sessions into modelHealth keyed by actualProvider::model", () => {
    const mh = buildModelHealthFromSessions([
      makeSession({
        actualProvider: "fireworks",
        actualModel: "kimi",
        status: "completed",
        latencyMs: 1200,
        ttftMs: 300,
        stopReason: "stop",
      }),
      makeSession({
        actualProvider: "fireworks",
        actualModel: "kimi",
        status: "errored",
        errorKind: "overloaded",
      }),
    ])
    const e = mh["fireworks::kimi"]!
    expect(e.requestCount).toBe(2)
    expect(e.latency.count).toBe(1) // only one carried a latencyMs sample
    expect(e.statusCounts.completed).toBe(1)
    expect(e.statusCounts.errored).toBe(1)
    expect(e.errorCounts.overloaded).toBe(1)
    expect(e.finishReasons!.stop).toBe(1)
  })

  it("falls back actualProvider→provider when the upstream is unknown (pre-F0)", () => {
    const mh = buildModelHealthFromSessions([
      makeSession({ provider: "teros", modelId: "kimi", status: "completed" }),
    ])
    expect(Object.keys(mh)).toEqual(["teros::kimi"])
  })

  it("equals the RollupAccumulator's modelHealth — the rollup and live paths CANNOT diverge", () => {
    const sessions = [
      makeSession({ actualProvider: "fireworks", actualModel: "kimi", latencyMs: 1000, ttftMs: 200 }),
      makeSession({
        actualProvider: "fireworks",
        actualModel: "kimi",
        status: "errored",
        errorKind: "rate_limited",
        fallbackUsed: true,
      }),
      makeSession({ actualProvider: "together", actualModel: "kimi", latencyMs: 500 }),
    ]
    // Rollup path: feed the accumulator (fraction/overlap don't affect modelHealth).
    const acc = RollupAccumulator.fromSession(sessions[0]!)
    for (const s of sessions) acc.add(s, 1, 10_000)
    const rollupMH = acc.toDoc({
      rollupId: "usro_x",
      hourBucket: new Date("2026-06-30T10:00:00Z"),
      computedAt: new Date("2026-06-30T11:00:00Z"),
      jobRunId: "usro_run",
    }).modelHealth
    // Live path: the handler's helper.
    const liveMH = buildModelHealthFromSessions(sessions)
    expect(liveMH).toEqual(rollupMH)
  })
})
