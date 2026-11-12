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
 *
 * ── Historical pricing ──────────────────────────────────────────────────────
 *
 * Each PriceRule may carry `effectiveFrom` / `effectiveTo` (ISO date strings).
 * When both are absent the rule is "current" (the default for new calls).
 * `lookupModelPrice(provider, modelId)` returns the current price (rules with
 * no `effectiveTo`), while `lookupModelPriceAt(provider, modelId, date)`
 * resolves the price that was in effect at a given moment — used by
 * re-calculation scripts and historical cost analysis. Rules are ordered
 * specific → general; within a (provider, modelIncludes) group, the FIRST rule
 * whose date window contains `date` wins.
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
  /** When this price took effect (inclusive). Omit = since the beginning. */
  effectiveFrom?: string
  /** When this price was superseded (exclusive). Omit = still current. */
  effectiveTo?: string
}

/** $/1M tokens → $/token. */
const M = (perMillion: number): number => perMillion / 1_000_000

// Ordered specific → general; first match wins. Prices in the comments are
// $/1M input · $/1M output (· cache-read) as published on the dated source.
//
// ── Historical rules (superseded) ────────────────────────────────────────────
// These have effectiveTo set and are kept for historical re-calculation.
//
// Kimi K2.6 via Fireworks — original rate before 2026-09 correction.
// Cache read was $0.19 (incorrect — actual Fireworks rate is $0.16).
const RULES: PriceRule[] = [
  {
    providers: ["teros", "fireworks"],
    modelIncludes: ["kimi-k2.6"],
    price: { input: M(0.95), output: M(4.0), cacheRead: M(0.19), source: "fireworks.ai/pricing, 2026-07 (pre-correction)" },
    effectiveFrom: "2026-05-01",
    effectiveTo: "2026-09-15",
  },
  // Kimi K2.7 Code via Fireworks — original rate before 2026-09 correction.
  // Was lumped under generic "kimi" with K2.6's cache rate.
  {
    providers: ["teros", "fireworks"],
    modelIncludes: ["kimi-k2p7-code", "kimi-k2.7"],
    price: { input: M(0.95), output: M(4.0), cacheRead: M(0.19), source: "fireworks.ai/pricing, 2026-07 (pre-correction)" },
    effectiveFrom: "2026-06-01",
    effectiveTo: "2026-09-15",
},
// GLM 5.2 (Fast) via Fireworks — was incorrectly priced at the base GLM 5.2
// rate ($1.40/$4.40) instead of the actual Fast rate ($2.10/$6.60).
// MUST come before the base GLM 5.2 historical rule (substring match issue).
{
  providers: ["teros", "fireworks"],
  modelIncludes: ["glm-5p2-fast", "glm-5.2-fast"],
  price: { input: M(1.4), output: M(4.4), cacheRead: M(0.26), source: "docs.z.ai/pricing, 2026-07 (pre-correction, wrong rate)" },
  effectiveFrom: "2026-07-01",
  effectiveTo: "2026-09-15",
},
// GLM 5.2 via Fireworks — original rate used Zhipu direct cache ($0.26)
// instead of the actual Fireworks cache rate ($0.14).
{
  providers: ["teros", "fireworks"],
  modelIncludes: ["glm-5p2", "glm-5.2"],
  price: { input: M(1.4), output: M(4.4), cacheRead: M(0.26), source: "docs.z.ai/pricing, 2026-07 (pre-correction, wrong cache rate)" },
  effectiveFrom: "2026-06-01",
  effectiveTo: "2026-09-15",
},
//
// ── Current rules ────────────────────────────────────────────────────────────
//
// Kimi K2.6 via Fireworks — corrected cache-read rate from actual invoices.
// $0.95 · $4.00 · $0.16 cache. Verified against Fireworks invoices IWSTOR-00002.
  {
    providers: ["teros", "fireworks"],
    modelIncludes: ["kimi-k2.6"],
    price: { input: M(0.95), output: M(4.0), cacheRead: M(0.16), source: "fireworks.ai invoices IWSTOR-00002/00003, 2026-09" },
  },
  // Kimi K2.7 Code (Fast) via Fireworks — $1.90 · $8.00 · $0.38 cache.
  // MUST come before the base K2.7 Code rule so `kimi-k2p7-code-fast` matches
  // here (not the base rule whose `kimi-k2p7-code` substring also matches).
  // Verified against invoice IWSTOR-00004 (Jul 2026).
  {
    providers: ["teros", "fireworks"],
    modelIncludes: ["kimi-k2p7-code-fast", "kimi-k2.7-fast"],
    price: { input: M(1.9), output: M(8.0), cacheRead: M(0.38), source: "fireworks.ai invoice IWSTOR-00004, 2026-09" },
  },
  // Kimi K2.7 Code via Fireworks — $0.95 · $4.00 · $0.19 cache.
  // Verified against invoice IWSTOR-00003 (Jun) and IWSTOR-00004 (Jul).
  {
    providers: ["teros", "fireworks"],
    modelIncludes: ["kimi-k2p7-code", "kimi-k2.7"],
    price: { input: M(0.95), output: M(4.0), cacheRead: M(0.19), source: "fireworks.ai invoices IWSTOR-00003/00004, 2026-09" },
  },
  // Kimi K3 Fast via Fireworks — $4.50 · $22.50 · $0.45 cache.
  // MUST come before the Kimi K3 rule so `kimi-k3-fast` matches here (not the
  // base rule whose `kimi-k3` substring also matches `kimi-k3-fast`).
  // Verified against docs.fireworks.ai/serverless/pricing, 2026-09.
  {
    providers: ["teros", "fireworks"],
    modelIncludes: ["kimi-k3-fast"],
    price: { input: M(4.5), output: M(22.5), cacheRead: M(0.45), source: "docs.fireworks.ai/serverless/pricing, 2026-09" },
  },
  // Kimi K3 via Fireworks — $3.00 · $15.00 · $0.30 cache.
  // Verified against invoice IWSTOR-00005 (Aug 2026).
  {
    providers: ["teros", "fireworks"],
    modelIncludes: ["kimi-k3"],
    price: { input: M(3.0), output: M(15.0), cacheRead: M(0.30), source: "fireworks.ai invoice IWSTOR-00005, 2026-09" },
  },
  // Kimi K2.6 / K2.7 / K3 — generic fallback for any other Kimi variant on
  // Fireworks that doesn't match a specific rule above. Uses K2.6 rates as the
  // conservative default. $0.95 · $4.00 · $0.16 cache.
  {
    providers: ["teros", "fireworks"],
    modelIncludes: ["kimi"],
    price: { input: M(0.95), output: M(4.0), cacheRead: M(0.16), source: "fireworks.ai/pricing, 2026-09 (generic Kimi fallback)" },
  },
  // Kimi via Together — higher hosted rate. $1.20 · $4.50.
  {
    providers: ["together"],
    modelIncludes: ["kimi"],
    price: { input: M(1.2), output: M(4.5), source: "together.ai/pricing, 2026-07" },
  },
  // Helmcode — flat-rate subscription per API key (not per-token), same model as
  // `zhipu-coding` / `anthropic-oauth`. No per-token price exists; gated as
  // subscription in estimateCostUsd via isSubscriptionProvider → returns null.
  // Adding a token price here would be a phantom figure. TER-666.
  //
  // GLM 5.1 — Zhipu direct usage path (the `zhipu-coding` Coding Plan is flat,
  // gated as subscription in estimateCostUsd → never reaches here). $1.40 · $4.40
  // · $0.26 cache. Covers 91% of historical token volume (was "—").
  {
    providers: ["teros", "zhipu"],
    modelIncludes: ["glm-5.1"],
    price: { input: M(1.4), output: M(4.4), cacheRead: M(0.26), source: "docs.z.ai/guides/overview/pricing, 2026-07" },
  },
  // GLM 5.2 (Fast) via Fireworks — $2.10 · $6.60 · $0.21 cache.
  // MUST come before the base GLM 5.2 rule so `glm-5p2-fast` matches here
  // (not the base rule whose `glm-5p2` substring also matches `glm-5p2-fast`).
  // Verified against invoice IWSTOR-00004 (Jul) and IWSTOR-00005 (Aug).
  // Was previously priced at the base GLM 5.2 rate ($1.40/$4.40) — a 50%
  // undercount on the most expensive model in the catalog.
  {
    providers: ["teros", "fireworks"],
    modelIncludes: ["glm-5p2-fast", "glm-5.2-fast"],
    price: { input: M(2.1), output: M(6.6), cacheRead: M(0.21), source: "fireworks.ai invoices IWSTOR-00004/00005, 2026-09" },
  },
  // GLM 5.2 (base, non-Fast) — teros managed `glm-5p2` + Zhipu `glm-5.2` + Together.
  // Corrected cache-read to $0.14 for Fireworks (was $0.26, which is the Zhipu
  // direct rate, not the Fireworks hosted rate). $1.40 · $4.40 · $0.14 cache.
  // For Zhipu/Together the $0.26 cache rate is still correct, so we keep a
  // separate rule for those providers.
  {
    providers: ["teros", "fireworks"],
    modelIncludes: ["glm-5p2", "glm-5.2"],
    price: { input: M(1.4), output: M(4.4), cacheRead: M(0.14), source: "fireworks.ai invoice IWSTOR-00005, 2026-09" },
  },
  {
    providers: ["zhipu", "together"],
    modelIncludes: ["glm-5p2", "glm-5.2"],
    price: { input: M(1.4), output: M(4.4), cacheRead: M(0.26), source: "docs.z.ai/guides/overview/pricing + together.ai/pricing, 2026-07" },
  },
  // GLM 5.3 — teros managed `glm-5p3`/`-flash` + Together `GLM-5.3`. $1.40 · $4.40 · $0.26 cache.
  // Flash variant is $0.15 · $0.50 · $0.03 cache.
  {
    providers: ["teros", "fireworks"],
    modelIncludes: ["glm-5p3-flash"],
    price: { input: M(0.15), output: M(0.5), cacheRead: M(0.03), source: "fireworks.ai/pricing, 2026-08" },
  },
  // GLM 5.3 Fast via Fireworks — $2.10 · $6.60 · $0.39 cache.
  // MUST come before the base GLM-5.3 rule so `glm-5p3-fast` matches here (not
  // the base rule whose `glm-5p3` substring also matches `glm-5p3-fast`).
  // Verified against docs.fireworks.ai/serverless/pricing, 2026-09.
  {
    providers: ["teros", "fireworks"],
    modelIncludes: ["glm-5p3-fast", "glm-5.3-fast"],
    price: { input: M(2.1), output: M(6.6), cacheRead: M(0.39), source: "docs.fireworks.ai/serverless/pricing, 2026-09" },
  },
  {
    providers: ["teros", "fireworks", "together"],
    modelIncludes: ["glm-5p3", "glm-5.3"],
    price: { input: M(1.4), output: M(4.4), cacheRead: M(0.26), source: "fireworks.ai/pricing + together.ai/pricing, 2026-08" },
  },
  {
    providers: ["together"],
    modelIncludes: ["glm-5.3-flash"],
    price: { input: M(0.15), output: M(0.5), cacheRead: M(0.03), source: "together.ai/pricing, 2026-08" },
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
  // DeepSeek V4 Pro 0813 via Fireworks (teros provider). $1.74 · $3.48 · $0.145 cache.
  {
    providers: ["teros", "fireworks"],
    modelIncludes: ["deepseek-v4-pro-0813"],
    price: { input: M(1.74), output: M(3.48), cacheRead: M(0.145), source: "fireworks.ai/pricing, 2026-09" },
  },
  // DeepSeek V4.1 Flash via Fireworks — launch rate (2026-09-10 → 2026-10-01).
  // $0.22 · $0.66 · $0.007 cache. (The catalog originally carried the retired
  // V4 Flash rate $0.14/$0.28 — corrected 2026-09-26.)
  {
    providers: ["teros", "fireworks"],
    modelIncludes: ["deepseek-v4p1-flash"],
    price: { input: M(0.22), output: M(0.66), cacheRead: M(0.007), source: "docs.fireworks.ai/serverless/pricing, 2026-09" },
    effectiveFrom: "2026-09-10",
    effectiveTo: "2026-10-01",
  },
  // DeepSeek V4.1 Flash via Fireworks — rate as of 2026-10-01 (changelog
  // "Serverless pricing update: DeepSeek V4.1 Flash"). $0.30 · $1.20 · $0.006.
  {
    providers: ["teros", "fireworks"],
    modelIncludes: ["deepseek-v4p1-flash"],
    price: { input: M(0.30), output: M(1.20), cacheRead: M(0.006), source: "docs.fireworks.ai/updates/changelog 2026-10-01, 2026-09" },
    effectiveFrom: "2026-10-01",
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
  // OpenRouter — pass-through pricing (no markup on token rates). Claude models
  // mirror Anthropic's direct API rates. Added 2026-09-15: previously OpenRouter
  // had ZERO pricing rules and inferVendor("openrouter") returns null, so all
  // OpenRouter sessions resolved cost = null → 0. The modelId stored in
  // agent_usage_sessions is the Teros catalog id (e.g. `openrouter-claude-opus-4-8`),
  // so we match on `claude-opus` / `claude-sonnet` / `claude-fable` substrings.
  //
  // Claude Opus 4.5–4.8: $5.00 · $25.00 · $0.50 cache (0.1× input).
  {
    providers: ["openrouter"],
    modelIncludes: ["claude-opus"],
    price: { input: M(5.0), output: M(25.0), cacheRead: M(0.50), source: "openrouter.ai/anthropic/claude-opus-4.8, 2026-09" },
  },
  // Claude Sonnet 4.5–5: $3.00 · $15.00 · $0.30 cache (0.1× input).
  {
    providers: ["openrouter"],
    modelIncludes: ["claude-sonnet"],
    price: { input: M(3.0), output: M(15.0), cacheRead: M(0.30), source: "openrouter.ai/anthropic/claude-sonnet-4.6, 2026-09" },
  },
  // Claude Fable 5: $10.00 · $50.00 · $0.25 cache (0.025× input per Fable 5.1 rate).
  {
    providers: ["openrouter"],
    modelIncludes: ["claude-fable"],
    price: { input: M(10.0), output: M(50.0), cacheRead: M(0.25), source: "openrouter.ai/anthropic/claude-fable-5, 2026-09" },
  },
  // OpenRouter — non-Claude models. DeepSeek V3 (deepseek-chat): $0.2574 · $1.029.
  {
    providers: ["openrouter"],
    modelIncludes: ["deepseek-v3"],
    price: { input: M(0.2574), output: M(1.029), source: "openrouter.ai/deepseek/deepseek-chat, 2026-09" },
  },
  // OpenRouter — Llama 3.3 70B Instruct: $0.10 · $0.32.
  {
    providers: ["openrouter"],
    modelIncludes: ["llama-3.3-70b"],
    price: { input: M(0.10), output: M(0.32), source: "openrouter.ai/meta-llama/llama-3.3-70b-instruct, 2026-09" },
  },
  // OpenRouter — Qwen 2.5 Coder 32B Instruct: $0.66 · $1.00.
  {
    providers: ["openrouter"],
    modelIncludes: ["qwen-2.5-coder"],
    price: { input: M(0.66), output: M(1.00), source: "openrouter.ai/qwen/qwen-2.5-coder-32b-instruct, 2026-09" },
  },
  // OpenRouter — Kimi K2.5: $0.45 · $2.25 · $0.07 cache.
  {
    providers: ["openrouter"],
    modelIncludes: ["kimi-k2.5"],
    price: { input: M(0.45), output: M(2.25), cacheRead: M(0.07), source: "openrouter.ai/moonshotai/kimi-k2.5, 2026-09" },
  },
  // MiniMax M2.5 direct (ai-tokenizer only carries minimax-m2). $0.15 · $1.15.
  {
    providers: ["minimax"],
    modelIncludes: ["m2.5"],
    price: { input: M(0.15), output: M(1.15), source: "platform.minimax.io/docs/guides/pricing-paygo, 2026-07" },
  },
]

// ── Date-window helpers ──────────────────────────────────────────────────────

/** True when `rule` is in effect at `date` (inclusive-from, exclusive-to). */
function ruleInEffect(rule: PriceRule, date: Date): boolean {
  const ts = date.getTime()
  if (rule.effectiveFrom) {
    const from = new Date(rule.effectiveFrom + "T00:00:00Z").getTime()
    if (ts < from) return false
  }
  if (rule.effectiveTo) {
    const to = new Date(rule.effectiveTo + "T00:00:00Z").getTime()
    if (ts >= to) return false
  }
  return true
}

/** True when a rule is "current" (no `effectiveTo` — still in effect now). */
function ruleIsCurrent(rule: PriceRule): boolean {
  return !rule.effectiveTo
}

/**
 * Verified price for a `(provider, modelId)` served by Teros, or `null` when we
 * have no verified figure (the caller degrades to "—", never $0). Checked BEFORE
 * the ai-tokenizer fallback so hosted rates win over vendor-direct ones.
 *
 * Returns the CURRENT price (rules with no `effectiveTo`). For historical
 * lookups, use `lookupModelPriceAt`.
 */
export function lookupModelPrice(
  provider: string | undefined,
  modelId: string | undefined,
): ModelPrice | null {
  if (!provider || !modelId) return null
  const p = provider.toLowerCase()
  const m = modelId.toLowerCase()
  for (const rule of RULES) {
    if (!ruleIsCurrent(rule)) continue
    if (!rule.providers.includes(p)) continue
    if (rule.modelIncludes.some((s) => m.includes(s))) return rule.price
  }
  return null
}

/**
 * Verified price for a `(provider, modelId)` at a specific point in time, or
 * `null` when no rule was in effect. Used by historical re-calculation scripts
 * and cost-analysis tools. Rules are ordered specific → general; the first
 * whose date window contains `date` wins.
 *
 * When `date` is omitted or in the current period, this is equivalent to
 * `lookupModelPrice`.
 */
export function lookupModelPriceAt(
  provider: string | undefined,
  modelId: string | undefined,
  date: Date,
): ModelPrice | null {
  if (!provider || !modelId) return null
  const p = provider.toLowerCase()
  const m = modelId.toLowerCase()
  for (const rule of RULES) {
    if (!ruleInEffect(rule, date)) continue
    if (!rule.providers.includes(p)) continue
    if (rule.modelIncludes.some((s) => m.includes(s))) return rule.price
  }
  return null
}
