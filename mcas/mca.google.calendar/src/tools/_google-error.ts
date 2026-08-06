/**
 * Classify a Google API error into a HealthCheckBuilder issue (code +
 * message + action) so the user sees the *real* cause, not an invented
 * "Reconnect your account" that hides the truth.
 *
 * Pattern lesson (28-Apr-2026): the previous implementation collapsed every
 * 401/403 to AUTH_EXPIRED with a generic message. A user spent 4 reconnects
 * trying to "fix" what was actually `accessNotConfigured` (Calendar API not
 * enabled in the GCP project) — admin_action, not user_action.
 *
 * Standard: this module is the single source of truth for translating Google
 * API errors. The `message` field always carries the LITERAL upstream
 * `error.message` so the caller is never blind. Only `description` (the
 * action) is tailored by code.
 */

export type IssueCode =
  | "AUTH_REQUIRED"
  | "AUTH_EXPIRED"
  | "AUTH_INVALID"
  | "AUTH_REVOKED"
  | "SYSTEM_CONFIG_MISSING"
  | "USER_CONFIG_MISSING"
  | "CONFIG_INVALID"
  | "DEPENDENCY_UNAVAILABLE"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "INTERNAL_ERROR"

export interface IssueAction {
  type: "user_action" | "admin_action" | "auto_retry"
  description: string
  url?: string
}

export interface ClassifiedIssue {
  code: IssueCode
  message: string
  action: IssueAction
}

interface GoogleApiErrorShape {
  code?: number | string
  message?: string
  errors?: Array<{ reason?: string; message?: string; domain?: string }>
  response?: {
    data?: {
      error?: {
        code?: number
        message?: string
        status?: string
        errors?: Array<{ reason?: string }>
      }
    }
  }
}

/**
 * Map a thrown error from `googleapis` (or the underlying fetch / GaxiosError)
 * to a structured issue. Always preserves the upstream `message` literally.
 */
export function classifyGoogleApiError(
  err: unknown,
  providerLabel = "Google API",
): ClassifiedIssue {
  const e = (err ?? {}) as GoogleApiErrorShape
  const code = normaliseCode(e.code)
  const reason = extractReason(e)
  const literalMessage = extractMessage(e) || `${providerLabel} error (no message)`

  // 403 with `accessNotConfigured` — the API is not enabled in the Cloud project.
  // This is admin-side and reconnecting OAuth does NOT fix it.
  if (code === 403 && reason === "accessNotConfigured") {
    return {
      code: "DEPENDENCY_UNAVAILABLE",
      message: literalMessage,
      action: {
        type: "admin_action",
        description:
          "Enable the corresponding Google API in the Google Cloud project that owns CLIENT_ID, then retry. Reconnecting OAuth will NOT fix this.",
        url: "https://console.cloud.google.com/apis/library",
      },
    }
  }

  // 403 with `insufficientPermissions` / `forbidden` — token lacks required scope.
  if (
    code === 403 &&
    (reason === "insufficientPermissions" ||
      reason === "forbidden" ||
      reason === "insufficientScope")
  ) {
    return {
      code: "AUTH_INVALID",
      message: literalMessage,
      action: {
        type: "user_action",
        description:
          "Token does not include the required scope. Revoke consent at https://myaccount.google.com/permissions and reconnect to re-grant the necessary scopes.",
      },
    }
  }

  // 403 daily / quota / billing.
  if (code === 403 && (reason === "dailyLimitExceeded" || reason === "quotaExceeded")) {
    return {
      code: "QUOTA_EXCEEDED",
      message: literalMessage,
      action: {
        type: "auto_retry",
        description: "API quota exceeded. Wait for quota reset or request more in Cloud Console.",
      },
    }
  }
  if (code === 403 && reason === "billingNotEnabled") {
    return {
      code: "DEPENDENCY_UNAVAILABLE",
      message: literalMessage,
      action: {
        type: "admin_action",
        description: "Enable billing on the Google Cloud project.",
        url: "https://console.cloud.google.com/billing",
      },
    }
  }

  // 401 — typical token expired or revoked.
  if (code === 401) {
    return {
      code: "AUTH_EXPIRED",
      message: literalMessage,
      action: {
        type: "user_action",
        description: "Reconnect your Google account.",
      },
    }
  }

  // 429 — rate limiting.
  if (code === 429 || reason === "userRateLimitExceeded" || reason === "rateLimitExceeded") {
    return {
      code: "RATE_LIMITED",
      message: literalMessage,
      action: {
        type: "auto_retry",
        description: "Rate limit hit. Will retry automatically.",
      },
    }
  }

  // 400 — bad request (malformed args by the agent).
  if (code === 400) {
    return {
      code: "INTERNAL_ERROR",
      message: literalMessage,
      action: {
        type: "auto_retry",
        description: "Bad request to the API. Re-check arguments.",
      },
    }
  }

  // 5xx and everything else — transient or unknown.
  if (typeof code === "number" && code >= 500) {
    return {
      code: "DEPENDENCY_UNAVAILABLE",
      message: literalMessage,
      action: {
        type: "auto_retry",
        description: "Google API transient error. Will retry automatically.",
      },
    }
  }

  // Fallback — unknown shape.
  return {
    code: "DEPENDENCY_UNAVAILABLE",
    message: literalMessage,
    action: {
      type: "auto_retry",
      description: "Google API responded with an unexpected error. Inspect the message above.",
    },
  }
}

function normaliseCode(raw: unknown): number | undefined {
  if (typeof raw === "number") return raw
  if (typeof raw === "string") {
    const n = Number.parseInt(raw, 10)
    return Number.isNaN(n) ? undefined : n
  }
  return undefined
}

function extractReason(e: GoogleApiErrorShape): string | undefined {
  return e.errors?.[0]?.reason ?? e.response?.data?.error?.errors?.[0]?.reason
}

function extractMessage(e: GoogleApiErrorShape): string | undefined {
  // `googleapis` sometimes nests the canonical message under response.data.error.
  return e.response?.data?.error?.message ?? e.message ?? e.errors?.[0]?.message
}
