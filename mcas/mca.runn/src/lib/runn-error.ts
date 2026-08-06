/**
 * Runn API Error Classifier
 *
 * Maps HTTP status + response body from the Runn REST API to a structured
 * error with a stable code and a user-actionable description. The `message`
 * field always preserves the literal upstream text so the caller (LLM or
 * user) sees the real reason — only the `description` (action) is templated.
 *
 * Runn error bodies are shaped `{ error, statusCode, message }`.
 * Pattern mirrors `mca.figma/src/lib/figma-error.ts:classifyFigmaError`.
 */

export type RunnIssueCode =
  | "AUTH_REQUIRED"
  | "AUTH_INVALID"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "VALIDATION_FAILED"
  | "DEPENDENCY_UNAVAILABLE"
  | "UNKNOWN"

export interface RunnIssueAction {
  type: "admin_action" | "user_action" | "auto_retry" | "reconnect"
  description: string
}

export class RunnApiError extends Error {
  /** Original upstream message (without the `[CODE]` prefix). */
  public readonly upstreamMessage: string

  constructor(
    public code: RunnIssueCode,
    upstreamMessage: string,
    public action: RunnIssueAction,
    public httpStatus?: number,
  ) {
    // Prepend `[CODE]` so the LLM can branch on the failure class
    // (AUTH_INVALID → reconnect, RATE_LIMITED → wait, NOT_FOUND → ask).
    // The mca-sdk only serialises `error.message` to the model — custom
    // fields like `code`/`action` are not exposed (SDK-wide limitation), so
    // the bracket prefix is the lightest way to surface the classification.
    super(`[${code}] ${upstreamMessage}`)
    this.upstreamMessage = upstreamMessage
    this.name = "RunnApiError"
  }
}

/**
 * Classify an HTTP error from the Runn API.
 * `body` is the raw response text — we parse `{ message, error }` if JSON.
 */
export function classifyRunnError(
  status: number,
  body: string,
  method: string,
  endpoint: string,
): RunnApiError {
  const upstreamMessage = parseRunnErrorMessage(body) ?? `${status} ${body.slice(0, 200)}`
  const where = `${method} ${endpoint}`

  switch (status) {
    case 401:
      return new RunnApiError(
        "AUTH_INVALID",
        upstreamMessage,
        {
          type: "user_action",
          description:
            "Your Runn API token is invalid or expired. Generate a new token in Runn (Settings > API) and update it in app settings.",
        },
        status,
      )
    case 403:
      return new RunnApiError(
        "PERMISSION_DENIED",
        upstreamMessage,
        {
          type: "user_action",
          description: `Your Runn API token lacks permission for ${where}. A read-only token cannot write — regenerate it with the "write" scope.`,
        },
        status,
      )
    case 404:
      return new RunnApiError(
        "NOT_FOUND",
        upstreamMessage,
        {
          type: "user_action",
          description: `Resource not found at ${endpoint}. Verify the id is correct and not archived.`,
        },
        status,
      )
    case 400:
    case 422:
      return new RunnApiError(
        "VALIDATION_FAILED",
        upstreamMessage,
        {
          type: "user_action",
          description: "Runn rejected the request. Check the parameters and retry.",
        },
        status,
      )
    case 429:
      return new RunnApiError(
        "RATE_LIMITED",
        upstreamMessage,
        {
          type: "auto_retry",
          description: "Runn rate limit exceeded (120 requests/minute). Wait and retry.",
        },
        status,
      )
    case 500:
    case 502:
    case 503:
    case 504:
      return new RunnApiError(
        "DEPENDENCY_UNAVAILABLE",
        upstreamMessage,
        {
          type: "auto_retry",
          description: "Runn API temporarily unavailable. Retry later.",
        },
        status,
      )
    default:
      return new RunnApiError(
        "UNKNOWN",
        upstreamMessage,
        {
          type: "auto_retry",
          description: `Unexpected HTTP ${status} from Runn at ${where}.`,
        },
        status,
      )
  }
}

function parseRunnErrorMessage(body: string): string | null {
  if (!body) return null
  const trimmed = body.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed.slice(0, 200)
  try {
    const parsed = JSON.parse(trimmed) as { message?: string; error?: string }
    return parsed.message ?? parsed.error ?? null
  } catch {
    return trimmed.slice(0, 200)
  }
}
