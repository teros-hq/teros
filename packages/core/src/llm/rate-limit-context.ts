/**
 * Rate-limit context helper — shared across fetch-based LLM adapters.
 *
 * When a provider returns HTTP 429, the frontend `RateLimitWidget` reads
 * `context.{isRateLimit, retryAfterSecs, retryAfterMs, resetAt, source}` to
 * render a countdown. This helper builds that context fragment from the error
 * headers so each adapter can populate it consistently.
 *
 * GOTCHA: the `retry-after` header must be read tolerating a native `Headers`
 * object (what fetch-based SDKs — `openai`, and therefore OpenRouter — pass)
 * AND a legacy plain object. Bracket access `headers["retry-after"]` returns
 * `undefined` on a native `Headers` instance, so the widget silently never
 * appears. We probe for `headers.get` first (same fix TER-469 applied to
 * `fromAnthropicError`).
 *
 * A `Retry-After` in HTTP-date format parses to NaN → `retryAfterSecs` is
 * `undefined`, which is acceptable: the widget still shows the generic
 * rate-limit state without a precise countdown.
 */

import type { ErrorContext } from "../errors/AgentError"

/**
 * Read the `retry-after` header tolerating both a native `Headers` instance
 * and a legacy plain object. Returns the parsed seconds, or `undefined` when
 * the header is absent or not an integer count (e.g. HTTP-date format).
 */
function readRetryAfterSecs(headers: unknown): number | undefined {
  const h = headers as { get?: (name: string) => string | null; [key: string]: unknown } | undefined
  const raw =
    typeof h?.get === "function" ? h.get("retry-after") : (h?.["retry-after"] as string | undefined)
  const parsed = raw ? parseInt(raw, 10) : Number.NaN
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * Build the rate-limit context fragment consumed by the frontend
 * `RateLimitWidget`. Always sets `isRateLimit: true`; the time fields are
 * `undefined` when the provider omits a usable `retry-after` header.
 *
 * @param headers The error headers (native `Headers` or plain object).
 * @param source Provider label shown in the widget (e.g. "OpenAI", "OpenRouter").
 */
export function populateRateLimitContext(
  headers: unknown,
  source: string,
): Partial<ErrorContext> {
  const retryAfterSecs = readRetryAfterSecs(headers)
  const retryAfterMs = retryAfterSecs ? retryAfterSecs * 1000 : undefined
  const resetAt = retryAfterMs ? Date.now() + retryAfterMs : undefined

  return {
    isRateLimit: true,
    retryAfterSecs,
    retryAfterMs,
    resetAt,
    source,
  }
}
