/**
 * Error model for mca.make.
 *
 * Every error message is prefixed with `[CODE]` so the LLM (which only receives
 * `error.message` over the MCA transport — see MCA-DEVELOPMENT.md §14.9) can
 * parse the bracket and decide how to react (`[AUTH_REQUIRED]` → ask the user to
 * configure a token, `[RATE_LIMITED]` → retry later, `[BAD_REQUEST]` → fix args).
 * The literal upstream message is preserved verbatim in `upstreamMessage`.
 */

export type MakeErrorCode =
  | 'BAD_REQUEST'
  | 'AUTH_REQUIRED'
  | 'AUTH_INVALID'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'UPSTREAM_ERROR';

export class MakeError extends Error {
  readonly code: MakeErrorCode;
  readonly status?: number;
  /** The upstream/literal message WITHOUT the `[CODE]` prefix (preserved for tests + inspection). */
  readonly upstreamMessage: string;

  constructor(code: MakeErrorCode, message: string, status?: number) {
    super(`[${code}] ${message}`);
    this.name = 'MakeError';
    this.code = code;
    this.status = status;
    this.upstreamMessage = message;
  }
}

/**
 * Map an HTTP status to a `MakeError` with the appropriate code. The `message`
 * passed in is preserved literally (only the `[CODE]` prefix is added by the
 * constructor) — never rewrite the upstream provider message.
 */
export function makeErrorFromStatus(status: number, message: string): MakeError {
  if (status === 400) return new MakeError('BAD_REQUEST', message, status);
  if (status === 401 || status === 403) return new MakeError('AUTH_INVALID', message, status);
  if (status === 404 || status === 410) return new MakeError('NOT_FOUND', message, status);
  if (status === 429) return new MakeError('RATE_LIMITED', message, status);
  if (status >= 500) return new MakeError('DEPENDENCY_UNAVAILABLE', message, status);
  return new MakeError('UPSTREAM_ERROR', message, status);
}

/**
 * Extract a human message from a Make API error body. Make returns several
 * shapes — `{ message }`, `{ detail }`, `{ error }` (5xx / not-implemented),
 * `{ error_description }`, and `{ errors: [...] }`. We include `error` in the
 * lookup so 5xx bodies don't leak raw JSON (see Canva incident, TER-216).
 * Falls back to `Make API error (<status>): <snippet>` when the body is not a
 * recognized JSON shape.
 */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function firstErrorMessage(errors: unknown): string | null {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first = errors[0];
  if (typeof first === 'string') return nonEmptyString(first);
  if (first && typeof first === 'object') {
    return nonEmptyString((first as Record<string, unknown>).message);
  }
  return null;
}

export function extractMakeApiMessage(text: string, status: number): string {
  const fallback = `Make API error (${status})`;
  if (!text || text.trim().length === 0) return fallback;

  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const direct = nonEmptyString(
      body.message ?? body.detail ?? body.error ?? body.error_description,
    );
    if (direct) return direct;

    const nested = firstErrorMessage(body.errors);
    if (nested) return nested;
  } catch {
    // not JSON — fall through to the snippet fallback below
  }

  return `${fallback}: ${truncate(text, 200)}`;
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}
