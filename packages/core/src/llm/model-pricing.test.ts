/**
 * model-pricing tests — Teros-owned hosted rates for the served catalog.
 * Pins that hosted models resolve their VERIFIED upstream price and that an
 * unverified version degrades to `null` (never mis-priced as a nearby model).
 */

import { describe, expect, it } from "bun:test"
import { lookupModelPrice } from "./model-pricing"

const M = (perMillion: number) => perMillion / 1_000_000

describe("lookupModelPrice", () => {
  it("prices the teros managed default (glm-5p2-fast) at the GLM 5.2 rate", () => {
    const p = lookupModelPrice("teros", "teros-glm-5p2-fast")
    expect(p).not.toBeNull()
    expect(p!.input).toBeCloseTo(M(1.4), 12)
    expect(p!.output).toBeCloseTo(M(4.4), 12)
  })

  it("prices teros/fireworks Kimi via Fireworks (with cache read)", () => {
    for (const modelId of ["teros-kimi-k2.6", "fireworks-kimi-k2p6", "kimi-k2p7-code"]) {
      const p = lookupModelPrice(modelId.startsWith("fireworks") ? "fireworks" : "teros", modelId)
      expect(p?.input).toBeCloseTo(M(0.95), 12)
      expect(p?.output).toBeCloseTo(M(4.0), 12)
      expect(p?.cacheRead).toBeCloseTo(M(0.19), 12)
    }
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
    // The lookup itself has no zhipu-coding rule — pricing is short-circuited by
    // the subscription gate in estimateCostUsd before RULES are consulted.
    expect(lookupModelPrice("zhipu-coding", "glm-5.1-coding")).toBeNull()
    expect(lookupModelPrice("zhipu-coding", "glm-5.2-coding")).toBeNull()
  })

  it("degrades to null for an unverified GLM version (not mis-priced as a nearby one)", () => {
    expect(lookupModelPrice("zhipu", "glm-6.0")).toBeNull()
  })

  it("degrades to null for an upstream with no verified rate (cloudflare)", () => {
    expect(lookupModelPrice("cloudflare", "cloudflare-kimi-k2.6")).toBeNull()
  })

  it("returns null on missing provider/modelId", () => {
    expect(lookupModelPrice(undefined, "x")).toBeNull()
    expect(lookupModelPrice("teros", undefined)).toBeNull()
  })
})
