/**
 * model-pricing tests — Teros-owned hosted rates for the served catalog.
 * Pins that hosted models resolve their VERIFIED upstream price and that an
 * unverified version degrades to `null` (never mis-priced as a nearby model).
 */

import { describe, expect, it } from "bun:test"
import { lookupModelPrice, lookupModelPriceAt } from "./model-pricing"

const M = (perMillion: number) => perMillion / 1_000_000

describe("lookupModelPrice — current rates", () => {
  it("prices teros/fireworks Kimi K2.6 with corrected cache-read ($0.16)", () => {
    const p = lookupModelPrice("teros", "teros-kimi-k2.6")
    expect(p).not.toBeNull()
    expect(p!.input).toBeCloseTo(M(0.95), 12)
    expect(p!.output).toBeCloseTo(M(4.0), 12)
    expect(p!.cacheRead).toBeCloseTo(M(0.16), 12) // corrected from $0.19
  })

  it("prices teros/fireworks Kimi K2.7 Code with $0.19 cache-read", () => {
    const p = lookupModelPrice("fireworks", "kimi-k2p7-code")
    expect(p).not.toBeNull()
    expect(p!.input).toBeCloseTo(M(0.95), 12)
    expect(p!.output).toBeCloseTo(M(4.0), 12)
    expect(p!.cacheRead).toBeCloseTo(M(0.19), 12)
  })

  it("prices Kimi K2.7 Code (Fast) at the verified Fast rate", () => {
    const p = lookupModelPrice("teros", "teros-kimi-k2p7-code-fast")
    expect(p).not.toBeNull()
    expect(p!.input).toBeCloseTo(M(1.9), 12)
    expect(p!.output).toBeCloseTo(M(8.0), 12)
    expect(p!.cacheRead).toBeCloseTo(M(0.38), 12)
  })

  it("prices Kimi K3 at the verified rate from Aug invoice", () => {
    const p = lookupModelPrice("teros", "teros-kimi-k3")
    expect(p).not.toBeNull()
    expect(p!.input).toBeCloseTo(M(3.0), 12)
    expect(p!.output).toBeCloseTo(M(15.0), 12)
    expect(p!.cacheRead).toBeCloseTo(M(0.30), 12)
  })

  it("prices the teros managed default (glm-5p2-fast) at the corrected GLM 5.2 Fast rate", () => {
    // Was $1.40/$4.40 (base GLM 5.2); now $2.10/$6.60 (actual Fast rate).
    const p = lookupModelPrice("teros", "teros-glm-5p2-fast")
    expect(p).not.toBeNull()
    expect(p!.input).toBeCloseTo(M(2.1), 12)
    expect(p!.output).toBeCloseTo(M(6.6), 12)
    expect(p!.cacheRead).toBeCloseTo(M(0.21), 12)
  })

  it("prices GLM 5.2 (base, non-Fast) via Fireworks with corrected cache-read ($0.14)", () => {
    const p = lookupModelPrice("fireworks", "glm-5.2")
    expect(p).not.toBeNull()
    expect(p!.input).toBeCloseTo(M(1.4), 12)
    expect(p!.output).toBeCloseTo(M(4.4), 12)
    expect(p!.cacheRead).toBeCloseTo(M(0.14), 12) // corrected from $0.26
  })

  it("prices GLM 5.2 via Zhipu/Together with the original $0.26 cache-read", () => {
    const zhipu = lookupModelPrice("zhipu", "glm-5.2")
    expect(zhipu).not.toBeNull()
    expect(zhipu!.cacheRead).toBeCloseTo(M(0.26), 12)

    const together = lookupModelPrice("together", "together-glm-5.2")
    expect(together).not.toBeNull()
    expect(together!.cacheRead).toBeCloseTo(M(0.26), 12)
  })

  it("prices Kimi via Together at Together's (higher) rate — provider-specific", () => {
    const p = lookupModelPrice("together", "together-kimi-k2.6")
    expect(p!.input).toBeCloseTo(M(1.2), 12) // NOT the Fireworks 0.95
    expect(p!.output).toBeCloseTo(M(4.5), 12)
  })

  it("prices Groq Llama 3.3 70B", () => {
    const p = lookupModelPrice("groq", "llama-3.3-70b-versatile")
    expect(p!.input).toBeCloseTo(M(0.59), 12)
    expect(p!.output).toBeCloseTo(M(0.79), 12)
  })

  it("prices GLM-5.1 on the zhipu direct (usage) path at the verified z.ai rate", () => {
    const p = lookupModelPrice("zhipu", "glm-5.1")
    expect(p!.input).toBeCloseTo(M(1.4), 12)
    expect(p!.output).toBeCloseTo(M(4.4), 12)
    expect(p!.cacheRead).toBeCloseTo(M(0.26), 12)
  })

  it("has NO rule for the zhipu-coding path (Coding Plan is flat; gated as subscription upstream)", () => {
    expect(lookupModelPrice("zhipu-coding", "glm-5.1-coding")).toBeNull()
    expect(lookupModelPrice("zhipu-coding", "glm-5.2-coding")).toBeNull()
  })

  it("degrades to null for an unverified GLM version (not mis-priced as a nearby one)", () => {
    expect(lookupModelPrice("zhipu", "glm-6.0")).toBeNull()
  })

  it("degrades to null for an upstream with no verified rate (cloudflare)", () => {
    expect(lookupModelPrice("cloudflare", "cloudflare-kimi-k2.6")).toBeNull()
  })

  // --- Bug fix 2026-09-15: external providers not registering cost ---

  it("prices together-glm-5.2 at the GLM 5.2 rate (together was missing from providers)", () => {
    const p = lookupModelPrice("together", "together-glm-5.2")
    expect(p).not.toBeNull()
    expect(p!.input).toBeCloseTo(M(1.4), 12)
    expect(p!.output).toBeCloseTo(M(4.4), 12)
    expect(p!.cacheRead).toBeCloseTo(M(0.26), 12)
  })

  it("prices openrouter Claude Opus models at Anthropic's direct rate", () => {
    for (const modelId of ["openrouter-claude-opus-4-8", "openrouter-claude-opus-4-5", "openrouter-claude-opus-4-6"]) {
      const p = lookupModelPrice("openrouter", modelId)
      expect(p).not.toBeNull()
      expect(p!.input).toBeCloseTo(M(5.0), 12)
      expect(p!.output).toBeCloseTo(M(25.0), 12)
      expect(p!.cacheRead).toBeCloseTo(M(0.50), 12)
    }
  })

  it("prices openrouter Claude Sonnet models at Anthropic's direct rate", () => {
    const p = lookupModelPrice("openrouter", "openrouter-claude-sonnet-4-6")
    expect(p).not.toBeNull()
    expect(p!.input).toBeCloseTo(M(3.0), 12)
    expect(p!.output).toBeCloseTo(M(15.0), 12)
    expect(p!.cacheRead).toBeCloseTo(M(0.30), 12)
  })

  it("prices openrouter Claude Fable 5", () => {
    const p = lookupModelPrice("openrouter", "openrouter-claude-fable-5")
    expect(p).not.toBeNull()
    expect(p!.input).toBeCloseTo(M(10.0), 12)
    expect(p!.output).toBeCloseTo(M(50.0), 12)
  })

  it("prices openrouter non-Claude models (deepseek, llama, qwen, kimi)", () => {
    const ds = lookupModelPrice("openrouter", "deepseek-v3")
    expect(ds!.input).toBeCloseTo(M(0.2574), 12)
    expect(ds!.output).toBeCloseTo(M(1.029), 12)

    const llama = lookupModelPrice("openrouter", "llama-3.3-70b-instruct")
    expect(llama!.input).toBeCloseTo(M(0.10), 12)
    expect(llama!.output).toBeCloseTo(M(0.32), 12)

    const qwen = lookupModelPrice("openrouter", "qwen-2.5-coder-32b")
    expect(qwen!.input).toBeCloseTo(M(0.66), 12)
    expect(qwen!.output).toBeCloseTo(M(1.00), 12)

    const kimi = lookupModelPrice("openrouter", "kimi-k2.5")
    expect(kimi!.input).toBeCloseTo(M(0.45), 12)
    expect(kimi!.output).toBeCloseTo(M(2.25), 12)
    expect(kimi!.cacheRead).toBeCloseTo(M(0.07), 12)
  })

  it("returns null on missing provider/modelId", () => {
    expect(lookupModelPrice(undefined, "x")).toBeNull()
    expect(lookupModelPrice("teros", undefined)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// lookupModelPriceAt — historical pricing
// ─────────────────────────────────────────────────────────────────────────────

describe("lookupModelPriceAt — historical pricing", () => {
  it("resolves the pre-correction Kimi K2.6 cache rate ($0.19) for July 2026", () => {
    const p = lookupModelPriceAt("teros", "teros-kimi-k2.6", new Date("2026-07-15T00:00:00Z"))
    expect(p).not.toBeNull()
    expect(p!.input).toBeCloseTo(M(0.95), 12)
    expect(p!.output).toBeCloseTo(M(4.0), 12)
    expect(p!.cacheRead).toBeCloseTo(M(0.19), 12) // old rate
  })

  it("resolves the corrected Kimi K2.6 cache rate ($0.16) for October 2026", () => {
    const p = lookupModelPriceAt("teros", "teros-kimi-k2.6", new Date("2026-10-01T00:00:00Z"))
    expect(p).not.toBeNull()
    expect(p!.cacheRead).toBeCloseTo(M(0.16), 12) // new rate
  })

  it("resolves the pre-correction GLM 5.2 Fast rate ($1.40) for July 2026", () => {
    const p = lookupModelPriceAt("teros", "teros-glm-5p2-fast", new Date("2026-07-15T00:00:00Z"))
    expect(p).not.toBeNull()
    expect(p!.input).toBeCloseTo(M(1.4), 12) // old (wrong) rate
    expect(p!.output).toBeCloseTo(M(4.4), 12)
  })

  it("resolves the corrected GLM 5.2 Fast rate ($2.10) for October 2026", () => {
    const p = lookupModelPriceAt("teros", "teros-glm-5p2-fast", new Date("2026-10-01T00:00:00Z"))
    expect(p).not.toBeNull()
    expect(p!.input).toBeCloseTo(M(2.1), 12) // new (correct) rate
    expect(p!.output).toBeCloseTo(M(6.6), 12)
  })

  it("resolves the pre-correction GLM 5.2 cache rate ($0.26) for July 2026 on Fireworks", () => {
    const p = lookupModelPriceAt("teros", "teros-glm-5p2", new Date("2026-07-15T00:00:00Z"))
    expect(p).not.toBeNull()
    expect(p!.cacheRead).toBeCloseTo(M(0.26), 12) // old rate
  })

  it("resolves the corrected GLM 5.2 cache rate ($0.14) for October 2026 on Fireworks", () => {
    const p = lookupModelPriceAt("teros", "teros-glm-5p2", new Date("2026-10-01T00:00:00Z"))
    expect(p).not.toBeNull()
    expect(p!.cacheRead).toBeCloseTo(M(0.14), 12) // new rate
  })

  it("returns null on missing provider/modelId", () => {
    expect(lookupModelPriceAt(undefined, "x", new Date())).toBeNull()
    expect(lookupModelPriceAt("teros", undefined, new Date())).toBeNull()
  })
})
