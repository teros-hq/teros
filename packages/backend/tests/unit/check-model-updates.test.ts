import { describe, expect, it } from "bun:test"
import type { ModelDefinition } from "../../src/models/types"
import {
  annotateWithLitellm,
  buildReport,
  deriveCompaction,
  deriveModelId,
  diffModel,
  diffOpenRouterApi,
  findNewModels,
  generateSnippet,
  litellmLookup,
  lookupCandidates,
  type ModelsDevData,
  type OpenRouterApiModel,
  parseArgs,
  type Sources,
  skipReason,
  type UpstreamModel,
} from "../../src/scripts/check-model-updates"

/** Fixed clock — the report must be deterministic (no wall-clock dependence) */
const NOW = new Date("2026-07-07T00:00:00.000Z")

function makeModel(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    modelId: "fireworks-test-model",
    provider: "fireworks",
    name: "Test Model (Fireworks)",
    description: "Test model.",
    modelString: "accounts/fireworks/models/test-model",
    capabilities: { streaming: true, tools: true, vision: false, thinking: true },
    context: { maxTokens: 262144, maxOutputTokens: 16384 },
    defaults: { temperature: 0.7, maxTokens: 8192 },
    reservations: { systemPrompt: 6000, memory: 12000, output: 8192 },
    compaction: { triggerAt: 200000, targetSize: 130000, protectRecent: 20000 },
    cost: { input: 1.0, output: 4.0, cacheRead: 0.1 },
    status: "active",
    ...overrides,
  }
}

function makeUpstream(id: string, overrides: Partial<UpstreamModel> = {}): UpstreamModel {
  return {
    id,
    name: `Name of ${id}`,
    description: "Upstream description. More detail here.",
    reasoning: true,
    tool_call: true,
    release_date: "2026-07-01",
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 262144, output: 16384 },
    cost: { input: 1.0, output: 4.0, cache_read: 0.1 },
    ...overrides,
  }
}

function mkSources(models: Record<string, UpstreamModel>, key = "fireworks-ai"): Sources {
  const modelsDev: ModelsDevData = { [key]: { models } }
  return { modelsDev }
}

// ============================================================================
// buildReport — end to end with fixtures
// ============================================================================

describe("buildReport", () => {
  it("returns the exact empty report when the catalog is in sync", () => {
    const model = makeModel()
    const sources = mkSources({
      "accounts/fireworks/models/test-model": makeUpstream("accounts/fireworks/models/test-model"),
    })
    const report = buildReport([model], sources, { now: NOW })
    expect(report).toEqual({
      meta: {
        checkedAt: "2026-07-07T00:00:00.000Z",
        sources: { modelsDev: true, litellm: false, openrouterApi: false },
        providersChecked: ["fireworks"],
        providersExcluded: [],
        omittedNew: {},
        nonAgenticSkipped: {},
        hasFindings: false,
      },
      newModels: [],
      drift: [],
      retired: [],
      skipped: [],
    })
  })

  it("reports field-by-field drift with the exact payload", () => {
    const model = makeModel()
    const sources = mkSources({
      "accounts/fireworks/models/test-model": makeUpstream("accounts/fireworks/models/test-model", {
        limit: { context: 300000, output: 32768 },
        cost: { input: 1.2, output: 4.0, cache_read: 0.1 },
        modalities: { input: ["text", "image"], output: ["text"] },
      }),
    })
    const report = buildReport([model], sources, { now: NOW })
    expect(report.drift).toEqual([
      {
        modelId: "fireworks-test-model",
        provider: "fireworks",
        modelString: "accounts/fireworks/models/test-model",
        upstreamId: "accounts/fireworks/models/test-model",
        fields: [
          { field: "context.maxTokens", ours: 262144, upstream: 300000 },
          { field: "context.maxOutputTokens", ours: 16384, upstream: 32768 },
          { field: "cost.input", ours: 1.0, upstream: 1.2 },
          { field: "capabilities.vision", ours: false, upstream: true },
        ],
      },
    ])
    expect(report.meta.hasFindings).toBe(true)
  })

  it("reports upstream-deprecated active models as retired", () => {
    const model = makeModel()
    const sources = mkSources({
      "accounts/fireworks/models/test-model": makeUpstream("accounts/fireworks/models/test-model", {
        status: "deprecated",
      }),
    })
    const report = buildReport([model], sources, { now: NOW })
    expect(report.retired).toEqual([
      {
        modelId: "fireworks-test-model",
        provider: "fireworks",
        modelString: "accounts/fireworks/models/test-model",
        reason: "deprecated-upstream",
      },
    ])
    expect(report.drift).toEqual([])
  })

  it("reports models missing upstream as retired", () => {
    const model = makeModel()
    const report = buildReport([model], mkSources({}), { now: NOW })
    expect(report.retired).toEqual([
      {
        modelId: "fireworks-test-model",
        provider: "fireworks",
        modelString: "accounts/fireworks/models/test-model",
        reason: "missing-upstream",
      },
    ])
  })

  it("ignores deprecated/disabled catalog models entirely", () => {
    const deprecated = makeModel({
      modelId: "fw-old",
      modelString: "accounts/fireworks/models/old",
      status: "deprecated",
    })
    const disabled = makeModel({
      modelId: "fw-off",
      modelString: "accounts/fireworks/models/off",
      status: "disabled",
    })
    const report = buildReport([deprecated, disabled], mkSources({}), { now: NOW })
    expect(report.drift).toEqual([])
    expect(report.retired).toEqual([])
  })

  it("does not compare context for OAuth providers (plan limits) but keeps capabilities", () => {
    const model = makeModel({
      modelId: "claude-test-oauth",
      provider: "anthropic-oauth",
      modelString: "claude-test-4-5",
      context: { maxTokens: 400000, maxOutputTokens: 128000 },
      cost: undefined,
    })
    const sources = mkSources(
      {
        "claude-test-4-5": makeUpstream("claude-test-4-5", {
          limit: { context: 200000, output: 64000 },
          tool_call: false,
        }),
      },
      "anthropic",
    )
    const report = buildReport([model], sources, { now: NOW })
    expect(report.drift).toEqual([
      {
        modelId: "claude-test-oauth",
        provider: "anthropic-oauth",
        modelString: "claude-test-4-5",
        upstreamId: "claude-test-4-5",
        fields: [{ field: "capabilities.tools", ours: true, upstream: false }],
      },
    ])
  })

  it("does not report thinking drift for google (deliberate adapter limitation)", () => {
    const model = makeModel({
      modelId: "gemini-test",
      provider: "google",
      modelString: "gemini-test",
      capabilities: { streaming: true, tools: true, vision: true, thinking: false },
      cost: undefined,
    })
    const sources = mkSources(
      {
        "gemini-test": makeUpstream("gemini-test", {
          reasoning: true,
          modalities: { input: ["text", "image"], output: ["text"] },
        }),
      },
      "google",
    )
    const report = buildReport([model], sources, { now: NOW })
    expect(report.drift).toEqual([])
  })

  it("matches anthropic modelStrings with date suffix against undated upstream ids", () => {
    const model = makeModel({
      modelId: "claude-test",
      provider: "anthropic",
      modelString: "claude-test-4-5-20250929",
      cost: undefined,
    })
    const sources = mkSources({ "claude-test-4-5": makeUpstream("claude-test-4-5") }, "anthropic")
    const report = buildReport([model], sources, { now: NOW })
    expect(report.retired).toEqual([])
    expect(report.drift).toEqual([])
  })

  it("matches ollama-cloud :cloud suffixes and annotates unmatched models with the tags URL", () => {
    const matched = makeModel({
      modelId: "ollama-cloud-glm-x",
      provider: "ollama-cloud",
      modelString: "glm-x:cloud",
      cost: undefined,
    })
    const missing = makeModel({
      modelId: "ollama-cloud-qwen-y",
      provider: "ollama-cloud",
      modelString: "qwen-y:480b-cloud",
      cost: undefined,
    })
    const sources = mkSources({ "glm-x": makeUpstream("glm-x") }, "ollama-cloud")
    const report = buildReport([matched, missing], sources, { now: NOW })
    expect(report.retired).toEqual([
      {
        modelId: "ollama-cloud-qwen-y",
        provider: "ollama-cloud",
        modelString: "qwen-y:480b-cloud",
        reason: "missing-upstream",
        note: "models.dev doesn't carry real tags — verify at https://ollama.com/library/qwen-y/tags",
      },
    ])
  })

  it("skips fireworks routers and openrouter/auto with explicit reasons", () => {
    const router = makeModel({
      modelId: "fireworks-fast",
      modelString: "accounts/fireworks/routers/test-fast",
    })
    const auto = makeModel({
      modelId: "openrouter-auto-cheapest",
      provider: "openrouter",
      modelString: "openrouter/auto",
      cost: undefined,
    })
    const sources: Sources = {
      modelsDev: { "fireworks-ai": { models: {} }, openrouter: { models: {} } },
    }
    const report = buildReport([router, auto], sources, { now: NOW })
    expect(report.skipped).toEqual([
      {
        modelId: "fireworks-fast",
        provider: "fireworks",
        reason: "Fireworks router variant — not listed in models.dev",
      },
      {
        modelId: "openrouter-auto-cheapest",
        provider: "openrouter",
        reason: "OpenRouter routing meta-model — no limits of its own",
      },
    ])
    expect(report.retired).toEqual([])
  })

  it("excludes teros/groq/ollama providers from any checking", () => {
    const teros = makeModel({
      modelId: "teros-x",
      provider: "teros",
      modelString: "accounts/fireworks/models/x",
    })
    const groq = makeModel({
      modelId: "groq-x",
      provider: "groq",
      modelString: "llama-x",
      cost: undefined,
    })
    const ollama = makeModel({
      modelId: "ollama-x",
      provider: "ollama",
      modelString: "qwen-x:7b",
      cost: undefined,
    })
    const report = buildReport([teros, groq, ollama], mkSources({}), { now: NOW })
    expect(report.meta.providersChecked).toEqual([])
    expect(report.meta.providersExcluded).toEqual(["teros", "groq", "ollama"])
    expect(report.retired).toEqual([])
    expect(report.newModels).toEqual([])
  })

  it("annotates drift with LiteLLM values (USD/token ×1e6)", () => {
    const model = makeModel()
    const sources: Sources = {
      ...mkSources({
        "accounts/fireworks/models/test-model": makeUpstream(
          "accounts/fireworks/models/test-model",
          {
            cost: { input: 1.25, output: 4.0, cache_read: 0.1 },
          },
        ),
      }),
      litellm: {
        "fireworks_ai/accounts/fireworks/models/test-model": { input_cost_per_token: 1.25e-6 },
      },
    }
    const report = buildReport([model], sources, { now: NOW })
    expect(report.meta.sources.litellm).toBe(true)
    expect(report.drift).toEqual([
      {
        modelId: "fireworks-test-model",
        provider: "fireworks",
        modelString: "accounts/fireworks/models/test-model",
        upstreamId: "accounts/fireworks/models/test-model",
        fields: [{ field: "cost.input", ours: 1.0, upstream: 1.25, note: "LiteLLM: 1.25" }],
      },
    ])
  })
})

// ============================================================================
// openrouter — the live API is authoritative
// ============================================================================

describe("openrouter live API", () => {
  const model = makeModel({
    modelId: "openrouter-claude-test",
    provider: "openrouter",
    modelString: "anthropic/claude-test",
    context: { maxTokens: 200000, maxOutputTokens: 64000 },
    cost: { input: 3.0, output: 15.0 },
  })
  const modelsDevStale = mkSources(
    {
      "anthropic/claude-test": makeUpstream("anthropic/claude-test", {
        limit: { context: 100000, output: 32000 },
        cost: { input: 3.0, output: 15.0 },
      }),
    },
    "openrouter",
  ).modelsDev

  function apiEntry(overrides: Partial<OpenRouterApiModel> = {}): OpenRouterApiModel {
    return {
      id: "anthropic/claude-test",
      context_length: 200000,
      top_provider: { max_completion_tokens: 64000 },
      pricing: { prompt: "0.000003", completion: "0.000015" },
      ...overrides,
    }
  }

  it("reports no drift when the live API agrees, even if models.dev is stale", () => {
    const report = buildReport(
      [model],
      { modelsDev: modelsDevStale, openrouterApi: [apiEntry()] },
      { now: NOW },
    )
    expect(report.drift).toEqual([])
    expect(report.retired).toEqual([])
  })

  it("reports drift against the live API with ×1e6 pricing conversion", () => {
    const api = apiEntry({
      context_length: 300000,
      pricing: { prompt: "0.0000028", completion: "0.000015" },
    })
    const report = buildReport(
      [model],
      { modelsDev: modelsDevStale, openrouterApi: [api] },
      { now: NOW },
    )
    expect(report.drift).toEqual([
      {
        modelId: "openrouter-claude-test",
        provider: "openrouter",
        modelString: "anthropic/claude-test",
        upstreamId: "anthropic/claude-test",
        fields: [
          { field: "context.maxTokens", ours: 200000, upstream: 300000 },
          { field: "cost.input", ours: 3.0, upstream: 2.8 },
        ],
      },
    ])
  })

  it("reports models absent from the live API as retired", () => {
    const report = buildReport(
      [model],
      { modelsDev: modelsDevStale, openrouterApi: [] },
      { now: NOW },
    )
    expect(report.retired).toEqual([
      {
        modelId: "openrouter-claude-test",
        provider: "openrouter",
        modelString: "anthropic/claude-test",
        reason: "missing-upstream",
        note: "Not listed in the live OpenRouter API",
      },
    ])
  })

  it("falls back to models.dev when the live API is unavailable", () => {
    const report = buildReport(
      [model],
      { modelsDev: modelsDevStale, openrouterApi: null },
      { now: NOW },
    )
    expect(report.drift).toEqual([
      {
        modelId: "openrouter-claude-test",
        provider: "openrouter",
        modelString: "anthropic/claude-test",
        upstreamId: "anthropic/claude-test",
        fields: [
          { field: "context.maxTokens", ours: 200000, upstream: 100000 },
          { field: "context.maxOutputTokens", ours: 64000, upstream: 32000 },
        ],
      },
    ])
  })
})

// ============================================================================
// NEW models
// ============================================================================

describe("new models", () => {
  it("reports an upstream model we don't have, with the exact ready-to-paste snippet", () => {
    const model = makeModel()
    const sources = mkSources({
      "accounts/fireworks/models/test-model": makeUpstream("accounts/fireworks/models/test-model"),
      "accounts/fireworks/models/shiny-new": makeUpstream("accounts/fireworks/models/shiny-new", {
        name: "Shiny New",
        description: "A shiny new model. It is great.",
        cost: { input: 2, output: 8, cache_read: 0.2 },
        modalities: { input: ["text", "image"], output: ["text"] },
      }),
    })
    const report = buildReport([model], sources, { now: NOW })
    expect(report.newModels).toEqual([
      {
        providerKey: "fireworks-ai",
        terosProvider: "fireworks",
        id: "accounts/fireworks/models/shiny-new",
        name: "Shiny New",
        releaseDate: "2026-07-01",
        snippet: [
          "  {",
          '    modelId: "fireworks-shiny-new",',
          '    provider: "fireworks",',
          '    name: "Shiny New (Fireworks)",',
          '    description: "A shiny new model.",',
          '    modelString: "accounts/fireworks/models/shiny-new",',
          "    capabilities: {",
          "      streaming: true,",
          "      tools: true,",
          "      vision: true,",
          "      thinking: true,",
          "    },",
          "    context: {",
          "      maxTokens: 262144,",
          "      maxOutputTokens: 16384,",
          "    },",
          "    defaults: {",
          "      temperature: 0.7,",
          "      maxTokens: 8192,",
          "    },",
          "    reservations: {",
          "      systemPrompt: 6000,",
          "      memory: 12000,",
          "      output: 8192,",
          "    },",
          "    compaction: {",
          "      triggerAt: 200000,",
          "      targetSize: 130000,",
          "      protectRecent: 20000,",
          "    },",
          "    cost: {",
          "      input: 2,",
          "      output: 8,",
          "      cacheRead: 0.2,",
          "    },",
          '    status: "active",',
          "  },",
        ].join("\n"),
      },
    ])
  })

  it("filters old upstream models on aggregators by release date, counting omissions", () => {
    const model = makeModel()
    const sources = mkSources({
      "accounts/fireworks/models/test-model": makeUpstream("accounts/fireworks/models/test-model"),
      "accounts/fireworks/models/ancient": makeUpstream("accounts/fireworks/models/ancient", {
        release_date: "2025-01-01",
      }),
    })
    const filtered = buildReport([model], sources, { now: NOW })
    expect(filtered.newModels).toEqual([])
    expect(filtered.meta.omittedNew).toEqual({ "fireworks-ai": 1 })

    const all = buildReport([model], sources, { now: NOW, allNew: true })
    expect(all.newModels.map((f) => f.id)).toEqual(["accounts/fireworks/models/ancient"])
    expect(all.meta.omittedNew).toEqual({})
  })

  it("applies the recency filter on first-party providers too", () => {
    const model = makeModel({
      modelId: "claude-a",
      provider: "anthropic",
      modelString: "claude-a",
      cost: undefined,
    })
    const sources = mkSources(
      {
        "claude-a": makeUpstream("claude-a"),
        "claude-b": makeUpstream("claude-b", { release_date: "2024-01-01" }),
      },
      "anthropic",
    )
    const report = buildReport([model], sources, { now: NOW })
    expect(report.newModels).toEqual([])
    expect(report.meta.omittedNew).toEqual({ anthropic: 1 })
  })

  it("includes cost in snippets even when the provider's first model doesn't track it", () => {
    // regression: fireworks' first catalog model has no cost, but the provider
    // is usage-billing — the snippet template must be a cost-tracking model
    const noCostFirst = makeModel({ cost: undefined })
    const withCost = makeModel({
      modelId: "fireworks-priced",
      modelString: "accounts/fireworks/models/priced",
      cost: { input: 1.0, output: 4.0, cacheRead: 0.1 },
    })
    const sources = mkSources({
      "accounts/fireworks/models/test-model": makeUpstream("accounts/fireworks/models/test-model"),
      "accounts/fireworks/models/priced": makeUpstream("accounts/fireworks/models/priced"),
      "accounts/fireworks/models/brand-new": makeUpstream("accounts/fireworks/models/brand-new", {
        cost: { input: 2, output: 8, cache_read: 0.2 },
      }),
    })
    const report = buildReport([noCostFirst, withCost], sources, { now: NOW })
    expect(report.newModels).toHaveLength(1)
    expect(report.newModels[0].snippet).toContain("cost: {")
    expect(report.newModels[0].snippet).toContain("input: 2,")
  })

  it("never suggests non-agentic upstream models, even with --all-new", () => {
    const model = makeModel()
    const sources = mkSources({
      "accounts/fireworks/models/test-model": makeUpstream("accounts/fireworks/models/test-model"),
      "accounts/fireworks/models/image-gen": makeUpstream("accounts/fireworks/models/image-gen", {
        tool_call: false,
        limit: { context: 0, output: 0 },
        modalities: { input: ["text"], output: ["image"] },
      }),
    })
    const report = buildReport([model], sources, { now: NOW, allNew: true })
    expect(report.newModels).toEqual([])
    expect(report.meta.nonAgenticSkipped).toEqual({ "fireworks-ai": 1 })
    expect(report.meta.omittedNew).toEqual({})
  })

  it("never suggests upstream-deprecated models as new", () => {
    const model = makeModel()
    const sources = mkSources({
      "accounts/fireworks/models/test-model": makeUpstream("accounts/fireworks/models/test-model"),
      "accounts/fireworks/models/dead": makeUpstream("accounts/fireworks/models/dead", {
        status: "deprecated",
      }),
    })
    const report = buildReport([model], sources, { now: NOW })
    expect(report.newModels).toEqual([])
  })

  it("dedupes dated/undated variants of the same upstream model, preferring undated", () => {
    const model = makeModel({
      modelId: "claude-a",
      provider: "anthropic",
      modelString: "claude-a",
      cost: undefined,
    })
    const sources = mkSources(
      {
        "claude-a": makeUpstream("claude-a"),
        "claude-new-1": makeUpstream("claude-new-1"),
        "claude-new-1-20260101": makeUpstream("claude-new-1-20260101"),
      },
      "anthropic",
    )
    const report = buildReport([model], sources, { now: NOW })
    expect(report.newModels.map((f) => f.id)).toEqual(["claude-new-1"])
  })

  it("groups oauth catalogs under the same models.dev key for coverage", () => {
    const api = makeModel({
      modelId: "claude-a",
      provider: "anthropic",
      modelString: "claude-a",
      cost: undefined,
    })
    const oauth = makeModel({
      modelId: "claude-b-oauth",
      provider: "anthropic-oauth",
      modelString: "claude-b",
      cost: undefined,
    })
    const sources = mkSources(
      { "claude-a": makeUpstream("claude-a"), "claude-b": makeUpstream("claude-b") },
      "anthropic",
    )
    const report = buildReport([api, oauth], sources, { now: NOW })
    expect(report.newModels).toEqual([])
  })
})

// ============================================================================
// pure helpers
// ============================================================================

describe("diffModel context tolerance", () => {
  it("swallows decimal vs binary convention noise but keeps real limit changes", () => {
    const model = makeModel({
      context: { maxTokens: 1000000, maxOutputTokens: 128000 },
      cost: undefined,
    })
    const convention = makeUpstream("x", { limit: { context: 1048576, output: 131072 } })
    expect(diffModel(model, convention)).toEqual([])

    const real = makeUpstream("x", { limit: { context: 2000000, output: 131072 } })
    expect(diffModel(model, real)).toEqual([
      { field: "context.maxTokens", ours: 1000000, upstream: 2000000 },
    ])
  })
})

describe("diffModel cost tolerance", () => {
  it("ignores sub-0.5% differences and reports beyond", () => {
    const model = makeModel()
    const within = makeUpstream("x", { cost: { input: 1.004, output: 4.0, cache_read: 0.1 } })
    expect(diffModel(model, within)).toEqual([])
    const beyond = makeUpstream("x", { cost: { input: 1.02, output: 4.0, cache_read: 0.1 } })
    expect(diffModel(model, beyond)).toEqual([{ field: "cost.input", ours: 1.0, upstream: 1.02 }])
  })

  it("skips cost when either side doesn't track it", () => {
    const noCost = makeModel({ cost: undefined })
    expect(diffModel(noCost, makeUpstream("x", { cost: { input: 99, output: 99 } }))).toEqual([])
    const model = makeModel()
    expect(diffModel(model, makeUpstream("x", { cost: undefined }))).toEqual([])
  })
})

describe("deriveCompaction", () => {
  it("matches the glm-5.2 pattern for 1M context", () => {
    expect(deriveCompaction(1000000, 131072, 20000)).toEqual({
      triggerAt: 850000,
      targetSize: 600000,
      protectRecent: 20000,
    })
  })

  it("matches the 200K catalog pattern", () => {
    expect(deriveCompaction(200000, 64000, 20000)).toEqual({
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 20000,
    })
  })

  it("keeps a meaningful gap below the trigger when huge maxOutputTokens clamps it (1M/384K)", () => {
    expect(deriveCompaction(1000000, 384000, 20000)).toEqual({
      triggerAt: 600000,
      targetSize: 450000,
      protectRecent: 20000,
    })
  })

  it("stays positive on tiny contexts (1K rounding step)", () => {
    expect(deriveCompaction(8192, 2048, 1000)).toEqual({
      triggerAt: 6000,
      targetSize: 4000,
      protectRecent: 1000,
    })
  })

  it("clamps the trigger on large contexts so headroom always exceeds maxOutputTokens", () => {
    expect(deriveCompaction(512000, 131072, 20000)).toEqual({
      triggerAt: 370000,
      targetSize: 270000,
      protectRecent: 20000,
    })
    for (const [ctx, maxOut] of [
      [1000000, 131072],
      [1048576, 131072],
      [800000, 65536],
      [512000, 131072],
    ] as const) {
      const { triggerAt, targetSize } = deriveCompaction(ctx, maxOut, 20000)
      expect(ctx - triggerAt).toBeGreaterThan(maxOut)
      expect(targetSize).toBeLessThan(triggerAt)
    }
  })
})

describe("deriveModelId", () => {
  it("follows each provider file's naming convention", () => {
    expect(deriveModelId("fireworks", "accounts/fireworks/models/foo-bar")).toBe(
      "fireworks-foo-bar",
    )
    expect(deriveModelId("cloudflare", "@cf/zai-org/glm-9")).toBe("cloudflare-glm-9")
    expect(deriveModelId("zhipu-coding", "glm-9")).toBe("glm-9-coding")
    expect(deriveModelId("anthropic", "claude-x-5-20260101")).toBe("claude-x-5")
    expect(deriveModelId("ollama-cloud", "deepseek-v9:671b")).toBe("ollama-cloud-deepseek-v9-671b")
    expect(deriveModelId("minimax", "MiniMax-M9")).toBe("minimax-m9")
  })
})

describe("lookupCandidates / skipReason", () => {
  it("generates provider-specific match candidates", () => {
    expect(lookupCandidates("anthropic", "claude-x-20260101")).toEqual([
      "claude-x-20260101",
      "claude-x",
    ])
    expect(lookupCandidates("ollama-cloud", "glm-x:cloud")).toEqual(["glm-x:cloud", "glm-x"])
    expect(lookupCandidates("ollama-cloud", "a:671b-cloud")).toEqual(["a:671b-cloud", "a:671b"])
    expect(lookupCandidates("openai", "gpt-x")).toEqual(["gpt-x"])
  })

  it("only skips known unverifiable models", () => {
    expect(skipReason(makeModel({ modelString: "accounts/fireworks/routers/x" }))).toContain(
      "router",
    )
    expect(
      skipReason(makeModel({ provider: "openrouter", modelString: "openrouter/auto" })),
    ).toContain("meta-model")
    expect(skipReason(makeModel())).toBeNull()
  })
})

describe("litellm cross-check", () => {
  it("looks up entries with provider-specific key prefixes", () => {
    const litellm = {
      "gemini/gemini-test": { max_input_tokens: 1000000 },
      "together_ai/org/model-x": { input_cost_per_token: 2e-7 },
    }
    expect(litellmLookup(litellm, "google", "gemini-test")).toEqual({ max_input_tokens: 1000000 })
    expect(litellmLookup(litellm, "together", "org/model-x")).toEqual({
      input_cost_per_token: 2e-7,
    })
    expect(litellmLookup(litellm, "openai", "gpt-x")).toBeNull()
  })

  it("annotates cost and context fields, leaving others untouched", () => {
    const fields = [
      { field: "cost.input", ours: 1, upstream: 2 },
      { field: "context.maxTokens", ours: 100, upstream: 200 },
      { field: "capabilities.vision", ours: false, upstream: true },
    ]
    const annotated = annotateWithLitellm(fields, {
      input_cost_per_token: 2e-6,
      max_input_tokens: 200,
    })
    expect(annotated).toEqual([
      { field: "cost.input", ours: 1, upstream: 2, note: "LiteLLM: 2" },
      { field: "context.maxTokens", ours: 100, upstream: 200, note: "LiteLLM: 200" },
      { field: "capabilities.vision", ours: false, upstream: true },
    ])
  })
})

describe("parseArgs", () => {
  it("parses the full option set exactly", () => {
    expect(
      parseArgs(["--json", "--all-new", "--new-days", "30", "--provider", "fireworks"]),
    ).toEqual({
      json: true,
      allNew: true,
      newDays: 30,
      provider: "fireworks",
    })
    expect(parseArgs([])).toEqual({})
  })

  it("rejects unknown flags and invalid values", () => {
    expect(() => parseArgs(["--write"])).toThrow("Unknown argument: --write")
    expect(() => parseArgs(["--new-days", "-5"])).toThrow("--new-days expects a positive number")
    expect(() => parseArgs(["--new-days", "abc"])).toThrow("--new-days expects a positive number")
  })
})

describe("findNewModels ordering", () => {
  it("sorts findings by release date, newest first", () => {
    const model = makeModel()
    const index = {
      "accounts/fireworks/models/a": makeUpstream("accounts/fireworks/models/a", {
        release_date: "2026-05-01",
      }),
      "accounts/fireworks/models/b": makeUpstream("accounts/fireworks/models/b", {
        release_date: "2026-06-15",
      }),
    }
    const { findings, omitted } = findNewModels("fireworks-ai", [model], index, [model], {
      now: NOW,
    })
    expect(findings.map((f) => f.id)).toEqual([
      "accounts/fireworks/models/b",
      "accounts/fireworks/models/a",
    ])
    expect(omitted).toBe(0)
  })
})

describe("generateSnippet compaction inheritance", () => {
  it("recalculates compaction only when the context size differs from the template", () => {
    const template = makeModel()
    const sameCtx = makeUpstream("accounts/fireworks/models/same", {
      limit: { context: 262144, output: 16384 },
    })
    expect(generateSnippet(sameCtx, "fireworks", template)).toContain("triggerAt: 200000,")

    const bigCtx = makeUpstream("accounts/fireworks/models/big", {
      limit: { context: 1000000, output: 131072 },
    })
    const snippet = generateSnippet(bigCtx, "fireworks", template)
    expect(snippet).toContain("maxTokens: 1000000,")
    expect(snippet).toContain("triggerAt: 850000,")
    expect(snippet).toContain("targetSize: 600000,")
  })
})

describe("generateSnippet hardening against untrusted upstream data", () => {
  it("JSON-escapes strings so upstream content cannot break out of the literal", () => {
    const evil = makeUpstream("accounts/fireworks/models/evil", {
      name: 'Evil"\n  status: "pwned',
      description: 'x", cost: { input: 0 }, //\\ injected',
    })
    const snippet = generateSnippet(evil, "fireworks", makeModel())
    const lines = snippet.split("\n")
    expect(lines).toContain(`    name: ${JSON.stringify('Evil"\n  status: "pwned (Fireworks)')},`)
    expect(lines).toContain(
      `    description: ${JSON.stringify('x", cost: { input: 0 }, //\\ injected')},`,
    )
    // no raw newline from the payload may open a new line of code
    expect(lines.filter((l) => l.trimStart().startsWith("status:"))).toEqual(['    status: "active",'])
  })

  it("coerces non-numeric and non-boolean upstream values instead of interpolating them", () => {
    const dirty = makeUpstream("accounts/fireworks/models/dirty", {
      cost: { input: "1); pwn(" as unknown as number, output: 4, cache_read: 0.1 },
      reasoning: "yes" as unknown as boolean,
      limit: { context: "262144" as unknown as number, output: 16384 },
    })
    const snippet = generateSnippet(dirty, "fireworks", makeModel())
    expect(snippet).toContain("      input: NaN,")
    expect(snippet).toContain("      thinking: false,")
    expect(snippet).toContain("      maxTokens: 262144,")
    expect(snippet).not.toContain("pwn")
  })
})

describe("diffOpenRouterApi", () => {
  it("skips max_completion_tokens when the API reports null", () => {
    const model = makeModel({
      provider: "openrouter",
      modelString: "x/y",
      context: { maxTokens: 100000, maxOutputTokens: 32000 },
      cost: undefined,
    })
    const api: OpenRouterApiModel = {
      id: "x/y",
      context_length: 100000,
      top_provider: { max_completion_tokens: null },
    }
    expect(diffOpenRouterApi(model, api)).toEqual([])
  })
})
