/**
 * Brevo API error classification.
 *
 * Maps HTTP status + response body to (IssueCode + IssueAction). The `message`
 * carried by `BrevoApiError` is the LITERAL upstream Brevo message — never
 * re-tuned. Only the `action.description` (what the user/agent should do) is
 * curated per code. Pattern from TER-222 (`_google-error.ts`) /
 * TER-216 (`_canva-error.ts`).
 *
 * The thrown `BrevoApiError.message` is prefixed with `[CODE]` so the LLM can
 * parse the bracket and decide what to do — the SDK only serializes
 * `error.message` to the model, dropping custom fields (CLAUDE.md §14.9
 * "Error code prefix `[CODE]`"). The literal upstream text is preserved in
 * `upstreamMessage` for tests / structured consumers.
 */

export type BrevoIssueCode =
  | 'AUTH_INVALID'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'PROVIDER_ERROR';

export interface BrevoIssueAction {
  type: 'user_action' | 'admin_action' | 'auto_retry';
  description: string;
}

export interface ClassifiedBrevoError {
  code: BrevoIssueCode;
  action: BrevoIssueAction;
  /** Literal upstream Brevo message. Never edited. */
  message: string;
}

/**
 * Pull the human message out of a Brevo error body.
 *
 * Brevo returns `{ code: "<slug>", message: "<human>" }` on most 4xx. Some
 * gateway/5xx paths use `error` / `error_description`. Order matters — without
 * the `error`/`code` fallbacks we'd surface raw JSON for those shapes.
 */
export function extractBrevoMessage(body: unknown, fallback: string): string {
  if (typeof body === 'string') return body.trim() || fallback;
  if (body && typeof body === 'object') {
    const b = body as {
      message?: unknown;
      error_description?: unknown;
      error?: unknown;
      code?: unknown;
    };
    // First field that is a non-empty (trimmed) string wins, else fallback.
    // Type-checked so a malformed numeric/object field can't leak through, and
    // robust to empty strings — `{ message: '' }` correctly skips to the next
    // field (or fallback) instead of surfacing a blank message.
    const pick = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim().length > 0 ? v : undefined;
    return pick(b.message) ?? pick(b.error_description) ?? pick(b.error) ?? pick(b.code) ?? fallback;
  }
  return fallback;
}

export function classifyBrevoError(
  status: number,
  body: unknown,
  fallbackMessage = 'Brevo API error',
): ClassifiedBrevoError {
  const message = extractBrevoMessage(body, fallbackMessage);

  if (status === 401) {
    return {
      code: 'AUTH_INVALID',
      action: {
        type: 'user_action',
        description:
          'The Brevo API key is missing or invalid. Re-enter it from Brevo → Settings → SMTP & API → API Keys.',
      },
      message,
    };
  }
  if (status === 403) {
    return {
      code: 'PERMISSION_DENIED',
      action: {
        type: 'user_action',
        description:
          'The API key lacks permission for this resource, or the sender email/domain is not verified in Brevo.',
      },
      message,
    };
  }
  if (status === 404) {
    return {
      code: 'NOT_FOUND',
      action: {
        type: 'user_action',
        description: 'Resource not found — check the id or email and whether it still exists.',
      },
      message,
    };
  }
  if (status === 429) {
    return {
      code: 'RATE_LIMITED',
      action: { type: 'auto_retry', description: 'Brevo rate limit hit; retry after a short delay.' },
      message,
    };
  }
  if (status === 400 || status === 422) {
    return {
      code: 'BAD_REQUEST',
      action: { type: 'user_action', description: 'Brevo rejected the request — see the message.' },
      message,
    };
  }
  if (status >= 500) {
    return {
      code: 'PROVIDER_ERROR',
      action: { type: 'auto_retry', description: 'Brevo API temporarily unavailable.' },
      message,
    };
  }
  return {
    code: 'PROVIDER_ERROR',
    action: { type: 'auto_retry', description: 'Unexpected Brevo API error.' },
    message,
  };
}

/**
 * Thrown by `brevoRequest` on non-OK responses (and on a missing API key).
 * `message` is `[CODE] <upstream literal>`; `upstreamMessage` keeps the raw
 * provider text for tests and structured consumers.
 */
export class BrevoApiError extends Error {
  readonly code: BrevoIssueCode;
  readonly httpStatus: number;
  readonly upstreamMessage: string;
  readonly action: BrevoIssueAction;

  constructor(
    code: BrevoIssueCode,
    httpStatus: number,
    upstreamMessage: string,
    action: BrevoIssueAction,
  ) {
    super(`[${code}] ${upstreamMessage}`);
    this.name = 'BrevoApiError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.upstreamMessage = upstreamMessage;
    this.action = action;
  }
}
