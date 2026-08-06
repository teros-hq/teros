/**
 * Usage normalization at the adapter boundary.
 *
 * Providers disagree on whether the reported prompt-token count INCLUDES the
 * cached-read tokens:
 *   - Anthropic / AnthropicOAuth / MiniMax: `input_tokens` EXCLUDES cache reads
 *     and writes (they are separate fields) — already the canonical shape.
 *   - OpenAI / Gemini / OpenAI-compatible (Fireworks/Together/…) / OpenRouter:
 *     `prompt_tokens` (or `promptTokenCount`) INCLUDES `cached_tokens` as a
 *     subset.
 *
 * The rest of the system (`estimateCostUsd`, the two parallel cost formulas,
 * the breakdown scaling in `TurnDriver`, the frontend cache hit-ratio) all
 * assume `inputTokens` means "NON-cached input", i.e. it adds the cached tokens
 * on top at the cache-read rate. When an adapter leaks the include-cached count,
 * the cached tokens are billed twice (once at full input rate inside
 * `inputTokens`, once at the cache-read rate) and the hit-ratio denominator is
 * inflated.
 *
 * This helper normalizes every adapter to the canonical "excludes cached" shape
 * at the single point where the `usage` object is built. `inputTokens +
 * cacheReadInputTokens` still reconstructs the full prompt size, so callers that
 * want the processed total keep it exact. See the deep audit §A2.1/A2.2.
 */
export function uncachedInputTokens(promptTokens: number, cachedReadTokens: number): number {
  return Math.max(0, promptTokens - cachedReadTokens)
}
