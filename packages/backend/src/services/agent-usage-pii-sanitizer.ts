/**
 * PII sanitizer for error messages.
 *
 * Applied to:
 *   - agent_usage_sessions.errorMessage
 *   - tool_executions.errorMessage
 *   - agent_usage_events.payload.errorMessage
 *
 * Strategy: regex-based redaction (defense in depth, not full coverage). The
 * upstream message is also truncated to 1k chars to bound storage / leak
 * surface.
 *
 * Patterns covered (best-effort):
 *   - Email addresses
 *   - JWT-shaped tokens (3 base64url segments separated by dots)
 *   - Bearer / API key patterns ("Bearer ...", "sk-...", "api_key=...")
 *   - Unix-style home paths (/Users/<name>/..., /home/<name>/...)
 *   - IP addresses (v4)
 *
 * NOT covered: prompt content, free-form names, internal IDs. These would
 * require structured stripping at the source, out of scope for this layer.
 *
 *
 */

const MAX_LEN = 1000

// Order matters: more specific patterns first.
const REDACTIONS: Array<{ re: RegExp; replacement: string }> = [
  // JWT (3 base64url segments)
  {
    re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replacement: "[REDACTED_JWT]",
  },
  // Bearer tokens
  { re: /\bBearer\s+[A-Za-z0-9_.\-]+/gi, replacement: "Bearer [REDACTED]" },
  // OpenAI-style API keys ("sk-..." with 20+ chars), Anthropic, etc.
  { re: /\b(sk|pk|ant|api)-[A-Za-z0-9_-]{16,}\b/gi, replacement: "[REDACTED_APIKEY]" },
  // Fireworks AI keys ("fw_..." with 20+ chars) — the `teros` upstream secret (R8.5).
  { re: /\bfw_[A-Za-z0-9]{20,}\b/g, replacement: "[REDACTED_APIKEY]" },
  // Generic api_key / token query params
  {
    re: /\b(api[_-]?key|token|secret|password)["'\s]*[:=]["'\s]*[A-Za-z0-9_\-.+/=]{8,}/gi,
    replacement: "$1=[REDACTED]",
  },
  // Emails
  {
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[REDACTED_EMAIL]",
  },
  // Unix-style home paths (preserve the parent directory shape but hide name)
  {
    re: /\/(?:Users|home)\/[A-Za-z0-9._-]+/g,
    replacement: "/[REDACTED_HOME]",
  },
  // IPv4 addresses
  { re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replacement: "[REDACTED_IP]" },
]

/**
 * Sanitize an error message before persisting it.
 *
 * Returns undefined when the input is empty or non-string (so callers can
 * conditionally include the field).
 */
export function sanitizeErrorMessage(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined
  const str = typeof raw === "string" ? raw : String((raw as { message?: unknown }).message ?? raw)
  if (!str || !str.trim()) return undefined

  let sanitized = str
  for (const { re, replacement } of REDACTIONS) {
    sanitized = sanitized.replace(re, replacement)
  }

  if (sanitized.length > MAX_LEN) {
    sanitized = sanitized.slice(0, MAX_LEN - 3) + "..."
  }

  return sanitized
}
