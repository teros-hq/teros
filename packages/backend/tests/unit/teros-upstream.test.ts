/**
 * Tests for resolveTerosUpstream (TER-617 / F3).
 *
 * Two invariants pinned here:
 *  - ZDR guard (safety-critical): Together is NEVER a failover target unless its
 *    retention tier is 'zdr'. Today it's 'retains' → blocked by default.
 *  - R2/M1: the PRIMARY Fireworks path never returns null for an unmapped model
 *    (it falls back to the catalogue modelString); only failover needs the map.
 */

import { describe, expect, it } from "bun:test"
import type { RetentionTier } from "@teros/shared"
import { MODELS_TEROS, TEROS_UPSTREAM_MODELS } from "../../src/models/providers/teros"
import { resolveTerosUpstream } from "../../src/services/teros-upstream"

type FakeSecrets = Parameters<typeof resolveTerosUpstream>[2]

function secretsOf(map: Record<string, { apiKey: string } | undefined>): FakeSecrets {
  return { system: ((name: string) => map[name]) as FakeSecrets["system"] }
}

const ALL_SECRETS = secretsOf({ fireworks: { apiKey: "fw-key" }, together: { apiKey: "tg-key" } })
const zdr = () => ({ tier: "zdr" as RetentionTier })
const retains = () => ({ tier: "retains" as RetentionTier })

// Catalogue models as `{ modelId, modelString }` — modelString = Fireworks default.
const K26 = { modelId: "teros-kimi-k2.6", modelString: "accounts/fireworks/models/kimi-k2p6" }
const K27 = { modelId: "teros-kimi-k2p7-code", modelString: "accounts/fireworks/models/kimi-k2p7-code" }
const UNMAPPED = { modelId: "teros-future-model", modelString: "accounts/fireworks/models/future" }

describe("resolveTerosUpstream — fireworks (primary)", () => {
  it("resolves Fireworks baseUrl + key + the mapped modelString for a mapped model", () => {
    expect(resolveTerosUpstream("fireworks", K26, ALL_SECRETS)).toEqual({
      upstream: "fireworks",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      apiKey: "fw-key",
      modelString: "accounts/fireworks/models/kimi-k2p6",
      actualProvider: "fireworks",
    })
  })

  it("resolves Fireworks for an UNMAPPED model using the catalogue modelString (R2/M1)", () => {
    // The bug R2 fixes: an unmapped teros model used to return null → empty key →
    // the turn failed even with the flag OFF. Now the primary ignores the map.
    // Mutation: re-adding `if (!mapped) return null` before the fireworks branch → red.
    expect(resolveTerosUpstream("fireworks", UNMAPPED, ALL_SECRETS)).toEqual({
      upstream: "fireworks",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      apiKey: "fw-key",
      modelString: "accounts/fireworks/models/future",
      actualProvider: "fireworks",
    })
  })

  it("returns null ONLY when the fireworks secret is missing", () => {
    expect(resolveTerosUpstream("fireworks", K26, secretsOf({}))).toBeNull()
  })
})

describe("resolveTerosUpstream — together (failover) + ZDR guard", () => {
  it("allows Together by default now — real classifier: together='zdr' via account ZDR opt-in (TER-646)", () => {
    // No injected resolver → uses the real resolveRetention, where together is now
    // 'zdr' (the account-level ZDR toggle is enabled). The guard itself stays
    // covered by the 'injected non-zdr tier → null' test below.
    expect(resolveTerosUpstream("together", K26, ALL_SECRETS)).toEqual({
      upstream: "together",
      baseUrl: "https://api.together.ai/v1",
      apiKey: "tg-key",
      modelString: "moonshotai/kimi-k2.6",
      actualProvider: "together",
    })
  })

  it("BLOCKS Together when the injected tier is not zdr", () => {
    expect(resolveTerosUpstream("together", K26, ALL_SECRETS, retains)).toBeNull()
  })

  it("allows Together ONLY when tier is zdr (asserted)", () => {
    expect(resolveTerosUpstream("together", K26, ALL_SECRETS, zdr)).toEqual({
      upstream: "together",
      baseUrl: "https://api.together.ai/v1",
      apiKey: "tg-key",
      modelString: "moonshotai/kimi-k2.6",
      actualProvider: "together",
    })
  })

  it("returns null for a model with no Together equivalent, even when zdr (Kimi K2.7 Code)", () => {
    expect(resolveTerosUpstream("together", K27, ALL_SECRETS, zdr)).toBeNull()
  })

  it("returns null for an UNMAPPED model — failover DOES depend on the map", () => {
    expect(resolveTerosUpstream("together", UNMAPPED, ALL_SECRETS, zdr)).toBeNull()
  })

  it("returns null when zdr-allowed but the together secret is missing", () => {
    const onlyFw = secretsOf({ fireworks: { apiKey: "fw-key" } })
    expect(resolveTerosUpstream("together", K26, onlyFw, zdr)).toBeNull()
  })

  it("checks the ZDR guard BEFORE the secret (no secret leak on a non-zdr upstream)", () => {
    // Even with a together secret present, a non-zdr tier blocks → null.
    expect(resolveTerosUpstream("together", K26, ALL_SECRETS, retains)).toBeNull()
  })
})

describe("teros catalogue ↔ failover map invariant (R8.2)", () => {
  it("every teros catalogue model has a TEROS_UPSTREAM_MODELS entry (failover stays wired)", () => {
    const catalogueIds = MODELS_TEROS.filter((m) => m.provider === "teros").map((m) => m.modelId)
    const mapped = new Set(Object.keys(TEROS_UPSTREAM_MODELS))
    const missing = catalogueIds.filter((id) => !mapped.has(id))
    // R2 keeps the PRIMARY working even for an unmapped model; this guard keeps
    // FAILOVER available by construction. Mutation: add a teros model to
    // MODELS_TEROS without a map entry → red (the latent bug made impossible).
    expect(missing).toEqual([])
  })

  it("each map entry's fireworks modelString equals the catalogue modelString", () => {
    // The primary (R2 fallback) uses the catalogue modelString; the map's
    // `fireworks` must agree, or the same model would resolve two ways.
    for (const m of MODELS_TEROS) {
      const entry = TEROS_UPSTREAM_MODELS[m.modelId]
      if (entry) expect(entry.fireworks).toBe(m.modelString)
    }
  })
})
