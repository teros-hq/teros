/**
 * Shared, provider-agnostic detector for context-length / prompt-too-long
 * errors.
 *
 * CTX-007: overflow recovery (`TurnDriver.retryWithRecoveredContext`) only
 * fires when `TurnDriver.isPromptTooLongError` sees either
 * `error.context.isContextLengthError === true` (structural) or a known
 * substring in `error.message` (fragile). Historically only OpenRouter set the
 * structural flag; every other adapter relied on luck-of-wording, and
 * Zhipu/MiniMax collapsed the 400 to the fixed string "Anthropic API bad
 * request" so overflow was never recovered — a hard, unrecoverable failure on
 * the default `teros`/OpenAICompatible provider too.
 *
 * Routing every adapter's error mapper through this single detector makes the
 * signal uniform by construction: a wording change in one provider can no
 * longer silently disable recovery, because there is one place to change.
 *
 * Callers MUST invoke this only inside a known 400/413 error branch, so the
 * substring match runs against request errors rather than arbitrary failures.
 * That bounds the cost of a false positive to one unnecessary compaction plus a
 * single retry (see `TurnDriver.retryWithRecoveredContext`).
 */

/**
 * Canonical substrings for context-length errors across providers. This is a
 * superset of the list `OpenRouterLLMAdapter` shipped (so OpenRouter behaviour
 * is preserved), extended with the wordings emitted by Anthropic, OpenAI,
 * Gemini, Zhipu (GLM), MiniMax, Fireworks and Together. All lower-cased and
 * matched against `${message} ${rawError}`.
 *
 * Deliberately excludes bare ambiguous tokens (e.g. "too long" on its own):
 * every entry is specific enough that a match inside a 400/413 is very likely a
 * genuine overflow.
 */
export const CONTEXT_LENGTH_PATTERNS = [
  "context_length_exceeded",
  "context length",
  "context window",
  "maximum context",
  "token limit",
  "tokens >",
  "prompt is too long",
  "input is too long",
  "input too long",
  "too many tokens",
  "reduce the length",
  "maximum number of tokens",
  "maximum input",
  "exceeds the maximum",
  "exceeds the model",
  "request too large",
  "max_tokens",
  "max_new_tokens", // Together/TGI: "inputs tokens + max_new_tokens must be <= N"
] as const

function stringifyRawError(rawError: unknown): string {
  if (rawError == null) return ""
  if (typeof rawError === "string") return rawError
  try {
    return JSON.stringify(rawError)
  } catch {
    return String(rawError)
  }
}

/**
 * Structural check for a context-length / prompt-too-long error.
 *
 * @param status  HTTP status (413 is treated as overflow unconditionally).
 * @param message The provider error message (deepest available).
 * @param rawError Optional extra signal — an error code, raw body string, or
 *   the raw error object. Objects are JSON-stringified before matching.
 */
export function isContextLengthExceeded(
  status: number | undefined,
  message?: string,
  rawError?: unknown,
): boolean {
  // 413 Payload Too Large is unambiguous: the request body exceeded the limit.
  if (status === 413) return true
  const combined = `${message ?? ""} ${stringifyRawError(rawError)}`.toLowerCase()
  return CONTEXT_LENGTH_PATTERNS.some((pattern) => combined.includes(pattern))
}
