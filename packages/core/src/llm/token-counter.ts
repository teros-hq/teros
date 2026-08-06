/**
 * Provider-aware token counter.
 *
 * Wraps `ai-tokenizer` (coder/ai-tokenizer, MIT) with a small mapping
 * provider → encoding. Replaces the legacy `chars/4` heuristic in
 * `PromptAnalyzer` with a BPE-aware count: 97%+ accuracy for Claude,
 * GPT-4/5 and OpenAI-family models; ~85-90% for OpenRouter / Ollama /
 * Zhipu / others (we fall back to `cl100k_base` which is the OpenAI BPE
 * that most modern LLMs approximate).
 *
 * Used ONLY for client-side estimation before the request. The actual
 * input token total comes from the provider response (`LLMResponse.usage`)
 * and is used as the source of truth for billing + a correction factor
 * to keep the per-category breakdown summing exactly to the real total.
 *
 * Tokenizers are cached per encoding (the cl100k/o200k/claude vocabularies
 * are 2-3 MB each on disk; instantiating once on demand is cheap, but we
 * keep a single instance per encoding to avoid GC churn).
 */

import Tokenizer, { models } from "ai-tokenizer"
import * as encoding from "ai-tokenizer/encoding"
import { isSubscriptionProvider } from "@teros/shared"
import { lookupModelPrice } from "./model-pricing"

type EncodingName = "claude" | "o200k_base" | "cl100k_base" | "p50k_base"

const tokenizers = new Map<EncodingName, Tokenizer>()

function getTokenizer(name: EncodingName): Tokenizer {
  let t = tokenizers.get(name)
  if (!t) {
    t = new Tokenizer(encoding[name])
    tokenizers.set(name, t)
  }
  return t
}

/**
 * Map a `LLMUsage.provider` value (or any provider string) to the closest
 * BPE encoding shipped with ai-tokenizer. Heuristic but stable; missing
 * providers fall back to `cl100k_base` which is the broadest OpenAI BPE.
 *
 * Justification by family:
 *   - claude:        Anthropic ships its own tokenizer ai-tokenizer mirrors.
 *   - o200k_base:    GPT-4o / GPT-5 / o-series (and a good aprox para Gemini).
 *   - cl100k_base:   GPT-3.5/4, default fallback (cubre OpenRouter / Ollama
 *                    para modelos modernos sin info específica).
 *   - p50k_base:     Solo Codex original; no lo asignamos por defecto a
 *                    nada — el codex-oauth de Teros usa modelos nuevos.
 */
export function encodingForProvider(provider: string | undefined): EncodingName {
  switch (provider) {
    case "anthropic":
    case "anthropic-oauth":
      return "claude"
    case "openai":
    // `codex-oauth` es alias legacy; el id canónico que persiste
    // `agentConfig.llm.provider` es `openai-codex-oauth` (LLMClientFactory).
    case "codex-oauth":
    case "openai-codex-oauth":
    // `gemini` es alias legacy; el id canónico es `google` (models.ts / registro).
    case "gemini":
    case "google":
      return "o200k_base"
    default:
      // openrouter / ollama / zhipu / zhipu-coding / fireworks / teros /
      // cloudflare / desconocidos → BPE OpenAI clásico
      return "cl100k_base"
  }
}

/**
 * Count tokens for a text using the encoding that best matches the
 * provider. `provider` undefined falls back to `cl100k_base`.
 *
 * Returns 0 for empty / null / undefined inputs (matches the previous
 * `estimateTokens` contract).
 */
export function countTokensForProvider(text: string | undefined, provider?: string): number {
  if (!text) return 0
  const enc = encodingForProvider(provider)
  const tokenizer = getTokenizer(enc)
  return tokenizer.count(text)
}

// ============================================================================
// Cost estimation
// ============================================================================

/**
 * Map un provider id de Teros → el vendor namespace de la pricing table de
 * ai-tokenizer (`<vendor>/<model>`). El provider id es el nombre lógico/adapter
 * de Teros; los aliases importan:
 *  - el id canónico es `google` (NO `gemini`) y `openai-codex-oauth` (NO
 *    `codex-oauth`) — la inferencia vieja chequeaba los strings equivocados, así
 *    que Gemini/codex nunca resolvían precio pese a tener entries (GAP 3a).
 *  - `minimax` añadido: `minimax/minimax-m2` existe en el registry; resuelve si
 *    el modelo servido casa, null si no.
 *
 * NO se mapean los upstreams OpenAI-compatible multi-modelo (teros / fireworks /
 * together / cloudflare / zhipu-coding): sirven modelos hosted (kimi-k2.6, glm-5.2)
 * MÁS NUEVOS que el registry, así que un mapeo por-provider daría precio de un
 * modelo distinto (bug de cambio-de-significado). Se precian en `model-pricing.ts`
 * (owned) con figura verificada; sin verificar quedan `null` → UI "—".
 */
function inferVendor(provider: string | undefined): string | null {
  switch (provider) {
    case "anthropic":
    case "anthropic-oauth":
      return "anthropic"
    case "openai":
    case "codex-oauth":
    case "openai-codex-oauth":
      return "openai"
    case "gemini":
    case "google":
      return "google"
    case "minimax":
      return "minimax"
    default:
      return null
  }
}

/**
 * Resolver `provider/modelId` → entry en `models` registry de ai-tokenizer.
 * Las claves de la librería son `<vendor>/<model>` (e.g.
 * `anthropic/claude-sonnet-4.5`, `openai/gpt-5`). Teros usa nombres distintos
 * según el adapter — este helper hace un best-effort match.
 *
 * Returns null si no hay match — el caller debe tratarlo como "unknown
 * cost" (UI muestra "—") en lugar de mentir con "$0".
 */
function resolveModelEntry(provider: string | undefined, modelId: string | undefined) {
  if (!provider || !modelId) return null
  const vendor = inferVendor(provider)
  if (!vendor) return null
  const candidates = [
    `${vendor}/${modelId}`,
    `${vendor}/${modelId.toLowerCase()}`,
  ]
  for (const key of candidates) {
    const entry = (models as Record<string, any>)[key]
    if (entry) return entry
  }
  // Fallback: search por substring
  const lookup = modelId.toLowerCase()
  for (const [key, value] of Object.entries(models as Record<string, any>)) {
    if (key.startsWith(`${vendor}/`) && key.toLowerCase().includes(lookup)) {
      return value
    }
  }
  return null
}

export interface CostBreakdownInput {
  provider?: string
  modelId?: string
  inputTokens: number
  outputTokens: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
  /**
   * Authoritative billing model when the caller knows it (e.g. the `models`
   * doc). `subscription` → the cost is a flat plan, so we return null instead of
   * a per-token figure. When absent, the provider registry decides
   * (`isSubscriptionProvider`). TER-666 / A2.4.
   */
  billingType?: "usage" | "subscription"
}

/** Per-component USD cost, or null when there is no verified/meaningful price. */
export interface CostBreakdownUsd {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

/**
 * True when this call must NOT be priced per token: an explicit `subscription`
 * billingType, or a provider the registry marks as subscription-billed (GLM
 * Coding Plan, Claude Max / ChatGPT OAuth). Prevents phantom per-token cost on
 * flat plans. TER-666 / A2.4.
 */
function isSubscriptionBilling(input: CostBreakdownInput): boolean {
  if (input.billingType === "subscription") return true
  if (input.billingType === "usage") return false
  return isSubscriptionProvider(input.provider)
}

/**
 * Per-component USD cost from token counts + the resolved price. Single price
 * resolution shared by `estimateCostUsd` (session cost) and the `llm_usage`
 * writer so both agree. Teros-owned pricing wins (hosted rates for the served
 * catalog); ai-tokenizer is the fallback for the vendor-direct families it
 * covers. Returns null for subscription billing or when no price is found (the
 * caller shows "Subscription" / "—", never a fabricated `0`).
 *
 * NOTE: reasoning tokens are a SUBSET of output tokens and are already priced by
 * the output rate — they are deliberately NOT charged again here (the old
 * `calculateCosts` double-charged them). A2.1.
 */
export function estimateCostBreakdownUsd(input: CostBreakdownInput): CostBreakdownUsd | null {
  if (isSubscriptionBilling(input)) return null
  const owned = lookupModelPrice(input.provider, input.modelId)
  let price: { input: number; output: number; cacheRead: number; cacheWrite: number } | null = null
  if (owned) {
    // No separate cache-write rate upstream → charge writes at the input rate.
    price = { input: owned.input, output: owned.output, cacheRead: owned.cacheRead ?? owned.input, cacheWrite: owned.input }
  } else {
    const entry = resolveModelEntry(input.provider, input.modelId)
    if (entry?.pricing) {
      const p = entry.pricing
      price = {
        input: p.input ?? 0,
        output: p.output ?? 0,
        cacheRead: p.input_cache_read ?? p.input ?? 0,
        cacheWrite: p.input_cache_write ?? p.input ?? 0,
      }
    }
  }
  if (!price) return null
  const costInput = input.inputTokens * price.input
  const costOutput = input.outputTokens * price.output
  const costCacheRead = (input.cachedReadTokens ?? 0) * price.cacheRead
  const costCacheWrite = (input.cachedWriteTokens ?? 0) * price.cacheWrite
  return {
    input: costInput,
    output: costOutput,
    cacheRead: costCacheRead,
    cacheWrite: costCacheWrite,
    total: costInput + costOutput + costCacheRead + costCacheWrite,
  }
}

/**
 * Estimate total USD cost from token counts + provider+model lookup. Devuelve
 * `null` si no hay pricing para el par dado o si es subscription (el caller debe
 * propagar como "—"/"Subscription", NO como `0`).
 */
export function estimateCostUsd(input: CostBreakdownInput): number | null {
  return estimateCostBreakdownUsd(input)?.total ?? null
}
