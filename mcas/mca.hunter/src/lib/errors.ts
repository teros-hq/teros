/**
 * Hunter.io error mapping.
 *
 * The MCA SDK only serializes `error.message` back to the LLM (the custom
 * `code`/`httpStatus` fields are lost in transport). Workaround (CLAUDE.md
 * §error-code-prefix): prepend `[CODE]` to the message so the model can parse
 * the bracket and decide to retry / reconnect / ask the user, while
 * `upstreamMessage` keeps the literal Hunter text for tests + debugging.
 */

export type HunterErrorCode =
  | 'AUTH_INVALID'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'PENDING'
  | 'DEPENDENCY_UNAVAILABLE';

export class HunterError extends Error {
  readonly code: HunterErrorCode;
  readonly httpStatus?: number;
  /** The literal upstream message (without the `[CODE]` prefix). */
  readonly upstreamMessage: string;

  constructor(code: HunterErrorCode, upstreamMessage: string, httpStatus?: number) {
    super(`[${code}] ${upstreamMessage}`);
    this.name = 'HunterError';
    this.code = code;
    this.upstreamMessage = upstreamMessage;
    this.httpStatus = httpStatus;
  }
}

/** Hunter error body shape: `{ errors: [{ id, code, details }] }`. */
interface HunterErrorBody {
  errors?: Array<{ id?: string; code?: number | string; details?: string }>;
}

/**
 * Extract a human-readable message from a Hunter error body, falling back to a
 * truncated raw body when the shape is unexpected.
 */
export function extractHunterMessage(rawBody: string, httpStatus: number): { id?: string; message: string } {
  let parsed: HunterErrorBody | undefined;
  try {
    parsed = JSON.parse(rawBody) as HunterErrorBody;
  } catch {
    parsed = undefined;
  }

  const first = parsed?.errors?.[0];
  if (first?.details) {
    return { id: first.id, message: first.details };
  }

  const trimmed = rawBody.trim();
  return {
    message: trimmed ? trimmed.slice(0, 200) : `Hunter API returned HTTP ${httpStatus}`,
  };
}

/**
 * Map an HTTP status + raw error body to a typed HunterError. Pure — no I/O,
 * unit-testable.
 */
export function classifyHunterError(httpStatus: number, rawBody: string): HunterError {
  const { message } = extractHunterMessage(rawBody, httpStatus);

  if (httpStatus === 401) {
    return new HunterError('AUTH_INVALID', message || 'Invalid or missing Hunter API key', 401);
  }

  // Hunter's documented scheme (api-documentation/v2):
  //   403 = rate limit reached (transient, per-second/minute) → retryable
  //   429 = monthly usage/credit limit reached → NOT retryable
  // (This is the OPPOSITE of the usual convention — do not "fix" it back.)
  if (httpStatus === 403) {
    return new HunterError('RATE_LIMITED', message || 'Hunter rate limit reached', 403);
  }

  if (httpStatus === 429) {
    return new HunterError('QUOTA_EXCEEDED', message || 'Monthly Hunter usage limit reached', 429);
  }

  if (httpStatus === 404) {
    return new HunterError('NOT_FOUND', message || 'Resource not found', 404);
  }

  if (httpStatus === 400 || httpStatus === 422) {
    return new HunterError('BAD_REQUEST', message || 'Invalid request parameters', httpStatus);
  }

  return new HunterError(
    'DEPENDENCY_UNAVAILABLE',
    message || `Hunter API error (HTTP ${httpStatus})`,
    httpStatus,
  );
}
