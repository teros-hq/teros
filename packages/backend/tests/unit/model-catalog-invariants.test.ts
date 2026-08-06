import { describe, expect, it } from "bun:test"
import { MODEL_DEFINITIONS } from "../../src/models/definitions"
import type { ModelDefinition } from "../../src/models/types"

/**
 * Structural guard over the model catalog (lint-as-test).
 *
 * The catalog feeds billing (Model.cost) and the conversation loop (context/
 * compaction budgets) straight through sync-models on every deploy, so a
 * broken entry must fail CI instead of reaching Mongo. This bites the same
 * way whether the entry was hand-written or pasted from a check-model-updates
 * snippet. NaN poisoning is caught too: NaN fails every > comparison.
 */

/** modelIds of the models violating a predicate — empty array means PASS */
function violations(pred: (m: ModelDefinition) => boolean): string[] {
  return MODEL_DEFINITIONS.filter((m) => !pred(m)).map((m) => m.modelId)
}

describe("model catalog invariants", () => {
  it("has globally unique modelIds", () => {
    const seen = new Map<string, number>()
    for (const m of MODEL_DEFINITIONS) {
      seen.set(m.modelId, (seen.get(m.modelId) ?? 0) + 1)
    }
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id)
    expect(dupes).toEqual([])
  })

  it("has non-empty modelStrings", () => {
    expect(violations((m) => m.modelString.trim().length > 0)).toEqual([])
  })

  it("has sane context limits (0 < maxOutputTokens <= maxTokens)", () => {
    expect(
      violations(
        (m) => m.context.maxOutputTokens > 0 && m.context.maxOutputTokens <= m.context.maxTokens,
      ),
    ).toEqual([])
  })

  it("has a coherent compaction ladder (protectRecent < targetSize < triggerAt < maxTokens)", () => {
    expect(
      violations(
        (m) =>
          m.compaction.protectRecent < m.compaction.targetSize &&
          m.compaction.targetSize < m.compaction.triggerAt &&
          m.compaction.triggerAt < m.context.maxTokens &&
          m.compaction.protectRecent > 0,
      ),
    ).toEqual([])
  })

  it("keeps default output within the model's output limit", () => {
    expect(violations((m) => m.defaults.maxTokens <= m.context.maxOutputTokens)).toEqual([])
  })

  it("keeps the output reservation in sync with the default output", () => {
    expect(violations((m) => m.reservations.output === m.defaults.maxTokens)).toEqual([])
  })

  it("has positive, coherent cost values when cost is tracked", () => {
    expect(
      violations(
        (m) =>
          !m.cost ||
          (m.cost.input > 0 &&
            m.cost.output > 0 &&
            (m.cost.cacheRead === undefined || (m.cost.cacheRead > 0 && m.cost.cacheRead < m.cost.input))),
      ),
    ).toEqual([])
  })

  it("tracks cost on ALL active models of a provider once any model tracks it", () => {
    // billing reads Model.cost — an active model without it on a cost-tracking
    // provider silently disables cost tracking for that model (this caught
    // teros-kimi-k2.6 and fireworks-kimi-k2p6 live)
    const providers = [...new Set(MODEL_DEFINITIONS.map((m) => m.provider))]
    const missing: string[] = []
    for (const provider of providers) {
      const models = MODEL_DEFINITIONS.filter((m) => m.provider === provider)
      if (!models.some((m) => m.cost)) continue
      missing.push(...models.filter((m) => m.status === "active" && !m.cost).map((m) => m.modelId))
    }
    expect(missing).toEqual([])
  })
})
