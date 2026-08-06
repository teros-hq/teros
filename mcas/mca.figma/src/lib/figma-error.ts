/**
 * Figma API Error Classifier
 *
 * Maps HTTP status + response body from the Figma REST API to a structured
 * error with a stable code and a user-actionable description. The `message`
 * field always preserves the literal upstream text so the caller (LLM or
 * user) sees the real reason — only the `description` (action) is templated.
 *
 * Pattern mirrors `mca.google.calendar/_google-error.ts:classifyGoogleApiError`.
 */

export type FigmaIssueCode =
  | "AUTH_REQUIRED"
  | "AUTH_EXPIRED"
  | "AUTH_INVALID"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "VALIDATION_FAILED"
  | "DEPENDENCY_UNAVAILABLE"
  | "SYSTEM_CONFIG_MISSING"
  | "UNKNOWN"

export interface FigmaIssueAction {
  type: "admin_action" | "user_action" | "auto_retry" | "reconnect"
  description: string
}

export class FigmaApiError extends Error {
  /** Original upstream message (without the `[CODE]` prefix). */
  public readonly upstreamMessage: string

  constructor(
    public code: FigmaIssueCode,
    upstreamMessage: string,
    public action: FigmaIssueAction,
    public httpStatus?: number,
  ) {
    // Prepend `[CODE]` to the message so the LLM can distinguish AUTH_EXPIRED
    // from RATE_LIMITED programmatically. The mca-sdk only serialises
    // `error.message` to the model — custom fields like `code` and `action`
    // are not exposed (SDK contract limitation, affects all MCAs). This is
    // the lightest way to surface the classification without touching the SDK.
    super(`[${code}] ${upstreamMessage}`)
    this.upstreamMessage = upstreamMessage
    this.name = "FigmaApiError"
  }
}

/**
 * Classify an HTTP error from the Figma API.
 * `body` is the raw response text — we try to parse `{ message }` if JSON.
 */
export function classifyFigmaError(
  status: number,
  body: string,
  method: string,
  endpoint: string,
): FigmaApiError {
  const upstreamMessage = parseFigmaErrorMessage(body) ?? `${status} ${body.slice(0, 200)}`
  const where = `${method} ${endpoint}`

  switch (status) {
    case 401:
      return new FigmaApiError(
        "AUTH_EXPIRED",
        upstreamMessage,
        {
          type: "reconnect",
          description: "Reconnect your Figma account to refresh the access token.",
        },
        status,
      )
    case 403:
      return new FigmaApiError(
        "PERMISSION_DENIED",
        upstreamMessage,
        {
          type: "user_action",
          description: `Your Figma account lacks permission for ${where}. Verify file access or OAuth scopes.`,
        },
        status,
      )
    case 404:
      return new FigmaApiError(
        "NOT_FOUND",
        upstreamMessage,
        {
          type: "user_action",
          description: `Resource not found at ${endpoint}. Verify the file key or node ID.`,
        },
        status,
      )
    case 400:
    case 422:
      return new FigmaApiError(
        "VALIDATION_FAILED",
        upstreamMessage,
        {
          type: "user_action",
          description: `Figma rejected the request. Check parameters and retry.`,
        },
        status,
      )
    case 429:
      return new FigmaApiError(
        "RATE_LIMITED",
        upstreamMessage,
        {
          type: "auto_retry",
          description: "Figma rate limit exceeded. Wait a minute and retry.",
        },
        status,
      )
    case 500:
    case 502:
    case 503:
    case 504:
      return new FigmaApiError(
        "DEPENDENCY_UNAVAILABLE",
        upstreamMessage,
        {
          type: "auto_retry",
          description: "Figma API temporarily unavailable. Retry later.",
        },
        status,
      )
    default:
      return new FigmaApiError(
        "UNKNOWN",
        upstreamMessage,
        {
          type: "auto_retry",
          description: `Unexpected HTTP ${status} from Figma at ${where}.`,
        },
        status,
      )
  }
}

function parseFigmaErrorMessage(body: string): string | null {
  if (!body) return null
  const trimmed = body.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed.slice(0, 200)
  try {
    const parsed = JSON.parse(trimmed) as { message?: string; err?: string; error?: string }
    return parsed.message ?? parsed.err ?? parsed.error ?? null
  } catch {
    return trimmed.slice(0, 200)
  }
}
