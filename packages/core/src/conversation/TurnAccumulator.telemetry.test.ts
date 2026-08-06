/**
 * Tests for TurnAccumulator instrumentation accumulation (TER-615 / F0).
 *
 * A turn can span several LLM steps (tool-calling loop). The accumulation rules
 * are easy to get subtly wrong, so they are pinned here:
 *  - TTFT  → FIRST step's value (the latency the user perceives in streaming).
 *  - latency → SUM across steps (total LLM wall-clock of the turn).
 *  - provider/model/generation/finishReason → LAST non-empty value.
 *  - reasoning tokens → summed via recordUsage.
 */

import { describe, expect, it } from "bun:test"
import { TurnAccumulator } from "./TurnDriver"

describe("TurnAccumulator telemetry (TER-615)", () => {
  it("keeps the FIRST TTFT, SUMS latency, and takes LAST-wins identity across steps", () => {
    const acc = new TurnAccumulator()
    acc.recordTelemetry({
      ttftMs: 100,
      serverTtftMs: 90,
      latencyMs: 800,
      actualProvider: "fireworks",
      actualModel: "kimi-a",
      generationId: "gen-1",
      finishReason: "tool_calls",
    })
    acc.recordTelemetry({
      ttftMs: 50, // a later step is faster — must NOT overwrite the first TTFT
      serverTtftMs: 40,
      latencyMs: 400,
      actualProvider: "fireworks",
      actualModel: "kimi-b",
      generationId: "gen-2",
      finishReason: "stop",
    })

    const t = acc.getTelemetry()
    expect(t.ttftMs).toBe(100) // FIRST, not 50
    expect(t.serverTtftMs).toBe(90) // FIRST
    expect(t.latencyMs).toBe(1200) // SUM 800 + 400
    expect(t.actualProvider).toBe("fireworks")
    expect(t.actualModel).toBe("kimi-b") // LAST
    expect(t.generationId).toBe("gen-2") // LAST
    expect(t.finishReason).toBe("stop") // LAST
  })

  it("sums reasoning tokens (and other token buckets) via recordUsage", () => {
    const acc = new TurnAccumulator()
    acc.recordUsage({ inputTokens: 10, outputTokens: 5, reasoningTokens: 3 })
    acc.recordUsage({
      inputTokens: 8,
      outputTokens: 4,
      reasoningTokens: 2,
      cacheReadInputTokens: 7,
    })
    const u = acc.getUsage()
    expect(u.inputTokens).toBe(18)
    expect(u.outputTokens).toBe(9)
    expect(u.reasoningTokens).toBe(5) // 3 + 2
    expect(u.cacheReadTokens).toBe(7)
  })

  it("treats reasoning tokens as 0 when absent (Fireworks honesty)", () => {
    const acc = new TurnAccumulator()
    acc.recordUsage({ inputTokens: 10, outputTokens: 5 })
    expect(acc.getUsage().reasoningTokens).toBe(0)
  })

  it("ignores undefined telemetry and partial fields without clobbering", () => {
    const acc = new TurnAccumulator()
    acc.recordTelemetry(undefined)
    acc.recordTelemetry({ latencyMs: 200 })
    acc.recordTelemetry({ actualProvider: "together" })
    const t = acc.getTelemetry()
    expect(t.ttftMs).toBeUndefined()
    expect(t.latencyMs).toBe(200)
    expect(t.actualProvider).toBe("together")
    expect(t.finishReason).toBeUndefined()
  })

  it("does not let a later empty provider overwrite an earlier real one", () => {
    const acc = new TurnAccumulator()
    acc.recordTelemetry({ actualProvider: "fireworks", actualModel: "kimi" })
    acc.recordTelemetry({ latencyMs: 10 }) // no provider/model → must keep previous
    const t = acc.getTelemetry()
    expect(t.actualProvider).toBe("fireworks")
    expect(t.actualModel).toBe("kimi")
  })
})
