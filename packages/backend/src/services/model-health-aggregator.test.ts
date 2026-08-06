/**
 * Tests for the model-health aggregator quality-rate denominators (A3.3 / TER-674).
 *
 * The bug class: a rate whose numerator excludes a population but whose
 * denominator does not, biasing the rate toward green. These tests assert the
 * EXACT rate so a mutation back to `requestCount` (the old denominator) breaks
 * them — the fix only bites if the denominator is the measurable population.
 */

import { describe, expect, it } from "bun:test"
import type { AgentUsageSession, ModelHealthEntry } from "../types/database.js"
import { emptyHistogram } from "./latency-histogram.js"
import { aggregateModelHealth, buildModelHealthFromSessions } from "./model-health-aggregator.js"

/** Minimal session carrying only the fields the aggregator reads. */
function mkSession(partial: Partial<AgentUsageSession>): AgentUsageSession {
  return {
    provider: "teros",
    actualProvider: "fireworks",
    modelId: "kimi",
    actualModel: "kimi",
    status: "completed",
    outputTokens: 10,
    toolCallCount: 0,
    ...partial,
  } as unknown as AgentUsageSession
}

/** Aggregate one live map (the path the in-progress hour uses). */
function summarizeSessions(sessions: AgentUsageSession[]) {
  const map = buildModelHealthFromSessions(sessions)
  const [summary] = aggregateModelHealth([{ modelHealth: map }])
  return summary
}

describe("emptyRate denominates over measuredCount, not requestCount", () => {
  it("excludes usagePartial turns from the denominator (a real 50% is not diluted to 10%)", () => {
    // 8 partial-usage turns (unmeasurable) + 2 reliable turns, 1 of which is empty.
    const sessions = [
      ...Array.from({ length: 8 }, () => mkSession({ usagePartial: true, outputTokens: 0 })),
      mkSession({ usagePartial: false, status: "completed", outputTokens: 0 }), // the empty one
      mkSession({ usagePartial: false, status: "completed", outputTokens: 42 }),
    ]
    const s = summarizeSessions(sessions)
    // measuredCount = 2, emptyCount = 1 → 0.5. The old bug (÷ requestCount 10) → 0.1.
    expect(s.emptyRate).toBe(0.5)
    expect(s.requestCount).toBe(10)
  })

  it("emptyRate is null when nothing measurable landed (all usagePartial)", () => {
    const s = summarizeSessions([
      mkSession({ usagePartial: true, outputTokens: 0 }),
      mkSession({ usagePartial: true, outputTokens: 0 }),
    ])
    expect(s.emptyRate).toBeNull() // measuredCount 0 → "—", not a spurious 0
  })
})

describe("truncationRate denominates over stopReasonCount", () => {
  it("only turns with a known finish_reason count in the denominator", () => {
    const sessions = [
      mkSession({ stopReason: "length" }), // truncated
      mkSession({ stopReason: "stop" }), // clean stop
      mkSession({}), // no finish_reason reported
      mkSession({}), // no finish_reason reported
    ]
    const s = summarizeSessions(sessions)
    // truncated = 1, stopReasonCount = 2 → 0.5. Old bug (÷ requestCount 4) → 0.25.
    expect(s.truncationRate).toBe(0.5)
  })

  it("truncationRate is null when no finish_reason was ever seen", () => {
    const s = summarizeSessions([mkSession({}), mkSession({})])
    expect(s.truncationRate).toBeNull()
  })
})

describe("successRate is null for an all-aborted bucket (A3.3)", () => {
  it("0/0 → null, never a red 0%", () => {
    const s = summarizeSessions([
      mkSession({ status: "aborted" }),
      mkSession({ status: "aborted" }),
    ])
    expect(s.successRate).toBeNull()
  })

  it("excludes aborts from the denominator but stays a number when some are gradeable", () => {
    const s = summarizeSessions([
      mkSession({ status: "completed" }),
      mkSession({ status: "aborted" }),
    ])
    expect(s.successRate).toBe(1) // 1 completed / (2 − 1 aborted) = 1
  })
})

describe("legacy rollups (no measuredCount/stopReasonCount) fall back to requestCount", () => {
  function legacyEntry(over: Partial<ModelHealthEntry>): ModelHealthEntry {
    return {
      actualProvider: "fireworks",
      modelId: "kimi",
      requestCount: 10,
      latency: emptyHistogram(),
      ttft: emptyHistogram(),
      statusCounts: { completed: 10 },
      errorCounts: {},
      finishReasons: {},
      emptyCount: 1,
      // NOTE: measuredCount / stopReasonCount intentionally absent (pre-TER-674 doc).
      ...over,
    }
  }

  it("keeps the pre-fix rate rather than showing a spurious '—'", () => {
    const [s] = aggregateModelHealth([{ modelHealth: { "fireworks::kimi": legacyEntry({}) } }])
    expect(s.emptyRate).toBe(0.1) // 1 / requestCount 10 (legacy fallback), not null
  })

  it("merging a legacy entry with a new one sums denominators consistently", () => {
    const legacy = legacyEntry({ requestCount: 4, emptyCount: 1 }) // → denom 4 (fallback)
    const fresh = legacyEntry({
      requestCount: 2,
      emptyCount: 1,
      measuredCount: 2,
      stopReasonCount: 2,
    })
    const [s] = aggregateModelHealth([
      { modelHealth: { "fireworks::kimi": legacy } },
      { modelHealth: { "fireworks::kimi": fresh } },
    ])
    // emptyCount 2 / (4 fallback + 2 measured) = 2/6.
    expect(s.emptyRate).toBeCloseTo(2 / 6, 10)
  })
})
