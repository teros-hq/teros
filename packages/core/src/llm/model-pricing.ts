/**
 * Teros-owned model pricing — the catalog Teros actually serves, priced from
 * the REAL upstream that bills us (Fireworks/Together/Zhipu/Groq/MiniMax), NOT
 * the model vendor's direct API. This is the primary source in `estimateCostUsd`;
 * ai-tokenizer stays as the fallback for the vendor-direct families it already
 * covers (Anthropic / OpenAI / Gemini / minimax-m2).
 *
 * WHY owned rules instead of mapping to ai-tokenizer: the served ids
 * (`teros-kimi-k2.6`, `teros-glm-5p2-fast`, `fireworks-kimi-k2p6`, …) are hosted
 * variants newer than / distinct from the vendor-direct entries, and Teros pays
 * the HOST's rate (e.g. Kimi via Fireworks, GLM 5.2 via the managed proxy), not
 * Moonshot/Zhipu direct. Every price here is VERIFIED against the upstream's
 * public pricing page on the dated `source`; a model without a verified price is
 * deliberately absent → cost resolves to `null` → UI shows "—", never a
 * fabricated figure.
 *
 * The lookup keys on the LOGICAL provider (what `agentConfig.llm.provider`
 * stores) + a substring of the modelId, because the caller passes
 * `actualModel || configuredModelId` — either the catalog id or the upstream
 * string. Substrings are chosen to be unambiguous (e.g. `kimi` only appears in
 * Kimi models); version-granular families are only priced where the version is
 * explicitly verified.
 */

/** Per-token USD pricing for a model. */
export interface ModelPrice {
  /** $ per non-cached input token. */
  input: number
  /** $ per output token. */
  output: number
  /** $ per cached-read input token (falls back to `input` when absent). */
  cacheRead?: number
  /** Upstream pricing page + date the figure was verified against. */
  source: string
}

interface PriceRule {
  /** Logical provider ids this rule applies to. */
  providers: string[]
  /** modelId (lowercased) must contain ONE of these. */
  modelIncludes: string[]
  price: ModelPrice
}

/** $/1M tokens → $/token. */
const M = (perMillion: number): number => perMillion / 1_000_000

// Ordered specific → general; first match wins. Prices in the comments are
// $/1M input · $/1M output (· cache-read) as published on the dated source.
const RULES: PriceRule[] = [
  // Kimi K2.6 / K2.7 via Fireworks — the teros managed default routes here;
  // Fireworks matches Moonshot's public rates. $0.95 · $4.00 · $0.19 cache.
  {
    providers: ["teros", "fireworks"],
    modelIncludes: ["kimi"],
    price: { input: M(0.95), output: M(4.0), cacheRead: M(0.19), source: "fireworks.ai/pricing + blog/kimi-k2p7-code, 2026-07" },
  },
  // Kimi via Together — higher hosted rate. $1.20 · $4.50.
  {
    providers: ["together"],
    modelIncludes: ["kimi"],
    price: { input: M(1.2), output: M(4.5), source: "together.ai/pricing, 2026-07" },
  },
  // GLM 5.1 — Zhipu direct usage path (the `zhipu-coding` Coding Plan is flat,
  // gated as subscription in estimateCostUsd → never reaches here). $1.40 · $4.40
  // · $0.26 cache. Covers 91% of historical token volume (was "—").
  {
    providers: ["teros", "zhipu"],
    modelIncludes: ["glm-5.1"],
    price: { input: M(1.4), output: M(4.4), cacheRead: M(0.26), source: "docs.z.ai/guides/overview/pricing, 2026-07" },
  },
  // GLM 5.2 — teros managed `glm-5p2`/`-fast` + Zhipu `glm-5.2`. $1.40 · $4.40 · $0.26 cache.
  {
    providers: ["teros", "zhipu"],
    modelIncludes: ["glm-5p2", "glm-5.2"],
    price: { input: M(1.4), output: M(4.4), cacheRead: M(0.26), source: "docs.z.ai/guides/overview/pricing, 2026-07" },
  },
  // GLM 5 Turbo. $1.20 · $4.00 · $0.24 cache.
  {
    providers: ["zhipu"],
    modelIncludes: ["glm-5-turbo"],
    price: { input: M(1.2), output: M(4.0), cacheRead: M(0.24), source: "docs.z.ai/guides/overview/pricing, 2026-07" },
  },
  // GLM 4.7 (+ coding). $0.60 · $2.20 · $0.11 cache.
  {
    providers: ["zhipu"],
    modelIncludes: ["glm-4.7"],
    price: { input: M(0.6), output: M(2.2), cacheRead: M(0.11), source: "docs.z.ai/guides/overview/pricing, 2026-07" },
  },
  // Groq Llama 3.3 70B. $0.59 · $0.79.
  {
    providers: ["groq"],
    modelIncludes: ["llama-3.3"],
    price: { input: M(0.59), output: M(0.79), source: "groq.com/pricing, 2026-07" },
  },
  // Together open models.
  {
    providers: ["together"],
    modelIncludes: ["deepseek-v4"],
    price: { input: M(2.1), output: M(4.4), source: "together.ai/pricing, 2026-07" },
  },
  {
    providers: ["together"],
    modelIncludes: ["llama-3.3"],
    price: { input: M(0.88), output: M(0.88), source: "together.ai/pricing, 2026-07" },
  },
  {
    providers: ["together"],
    modelIncludes: ["qwen"],
    price: { input: M(0.5), output: M(3.0), source: "together.ai/pricing, 2026-07" },
  },
  // MiniMax M2.5 direct (ai-tokenizer only carries minimax-m2). $0.15 · $1.15.
  {
    providers: ["minimax"],
    modelIncludes: ["m2.5"],
    price: { input: M(0.15), output: M(1.15), source: "platform.minimax.io/docs/guides/pricing-paygo, 2026-07" },
  },
]

/**
 * Verified price for a `(provider, modelId)` served by Teros, or `null` when we
 * have no verified figure (the caller degrades to "—", never $0). Checked BEFORE
 * the ai-tokenizer fallback so hosted rates win over vendor-direct ones.
 */
export function lookupModelPrice(
  provider: string | undefined,
  modelId: string | undefined,
): ModelPrice | null {
  if (!provider || !modelId) return null
  const p = provider.toLowerCase()
  const m = modelId.toLowerCase()
  for (const rule of RULES) {
    if (!rule.providers.includes(p)) continue
    if (rule.modelIncludes.some((s) => m.includes(s))) return rule.price
  }
  return null
}
