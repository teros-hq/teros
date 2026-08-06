import { describe, expect, it } from "bun:test"
import { estimateCostUsd } from "./token-counter"
import { uncachedInputTokens } from "./usage-normalize"

describe("uncachedInputTokens (A2.1 — boundary normalization)", () => {
  it("subtracts cached tokens from the include-cached prompt count", () => {
    expect(uncachedInputTokens(100, 30)).toBe(70)
    expect(uncachedInputTokens(100, 64)).toBe(36)
  })

  it("returns the full prompt count when nothing is cached", () => {
    expect(uncachedInputTokens(100, 0)).toBe(100)
  })

  it("returns 0 for a 100% cache-hit prompt (not negative)", () => {
    expect(uncachedInputTokens(100, 100)).toBe(0)
  })

  it("clamps to 0 if the provider ever reports cached > prompt (defensive)", () => {
    expect(uncachedInputTokens(50, 80)).toBe(0)
  })

  it("preserves the full prompt size via inputTokens + cached", () => {
    const prompt = 1000
    const cached = 900
    const input = uncachedInputTokens(prompt, cached)
    expect(input + cached).toBe(prompt)
  })
})

describe("no cost double-count once inputTokens excludes cached (A2.1)", () => {
  // Fireworks/Kimi (the default managed path): $0.95/M input, $0.19/M cacheRead
  // (owned rule in model-pricing.ts). A 1M-token prompt with 900k cached.
  const provider = "teros"
  const modelId = "accounts/fireworks/models/kimi-k2p6"

  it("charges cached tokens once (at the cache-read rate), not twice", () => {
    const prompt = 1_000_000
    const cached = 900_000
    const cost = estimateCostUsd({
      provider,
      modelId,
      // Post-fix shape: inputTokens is the NON-cached remainder.
      inputTokens: uncachedInputTokens(prompt, cached),
      outputTokens: 0,
      cachedReadTokens: cached,
      cachedWriteTokens: 0,
    })
    // Correct: 100k non-cached × $0.95/M + 900k cached × $0.19/M = $0.095 + $0.171
    expect(cost).toBeCloseTo(0.095 + 0.171, 6)
  })

  it("the pre-fix shape (inputTokens = full prompt) would have over-charged ~4×", () => {
    const prompt = 1_000_000
    const cached = 900_000
    const wrong = estimateCostUsd({
      provider,
      modelId,
      inputTokens: prompt, // the bug: include-cached leaked through
      outputTokens: 0,
      cachedReadTokens: cached,
      cachedWriteTokens: 0,
    })
    const right = estimateCostUsd({
      provider,
      modelId,
      inputTokens: uncachedInputTokens(prompt, cached),
      outputTokens: 0,
      cachedReadTokens: cached,
      cachedWriteTokens: 0,
    })
    // Documents the magnitude the fix removes on the default path.
    expect((wrong as number) / (right as number)).toBeGreaterThan(3)
  })
})
