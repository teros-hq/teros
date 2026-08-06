/**
 * Typed errors for ActiveCampaign API responses.
 * The handler decides what to retry; classifier maps HTTP status -> typed error.
 */

export type ActiveCampaignErrorCode =
  | 'AUTH_INVALID'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'API_ERROR';

export class ActiveCampaignError extends Error {
  readonly code: ActiveCampaignErrorCode;
  readonly status: number;
  readonly upstreamMessage: string;

  constructor(code: ActiveCampaignErrorCode, status: number, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'ActiveCampaignError';
    this.code = code;
    this.status = status;
    this.upstreamMessage = message;
  }
}

export class ActiveCampaignAuthError extends ActiveCampaignError {
  constructor(status: number, message: string) {
    super('AUTH_INVALID', status, message);
    this.name = 'ActiveCampaignAuthError';
  }
}

export class ActiveCampaignNotFoundError extends ActiveCampaignError {
  constructor(message: string) {
    super('NOT_FOUND', 404, message);
    this.name = 'ActiveCampaignNotFoundError';
  }
}

export class ActiveCampaignRateLimitError extends ActiveCampaignError {
  readonly retryAfterSeconds: number | null;

  constructor(message: string, retryAfterSeconds: number | null) {
    super('RATE_LIMITED', 429, message);
    this.name = 'ActiveCampaignRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ActiveCampaignBadRequestError extends ActiveCampaignError {
  constructor(status: number, message: string) {
    super('BAD_REQUEST', status, message);
    this.name = 'ActiveCampaignBadRequestError';
  }
}

interface AcErrorBody {
  errors?: Array<{ title?: string; message?: string; code?: string; detail?: string }>;
  message?: string;
  error?: string;
}

export function extractAcErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const b = body as AcErrorBody;
  if (Array.isArray(b.errors) && b.errors.length > 0) {
    const first = b.errors[0];
    return first.title || first.message || first.detail || fallback;
  }
  return b.message || b.error || fallback;
}

export function classifyAcError(status: number, body: unknown): ActiveCampaignError {
  const message = extractAcErrorMessage(body, `HTTP ${status}`);
  if (status === 401 || status === 403) return new ActiveCampaignAuthError(status, message);
  if (status === 404) return new ActiveCampaignNotFoundError(message);
  if (status === 429) {
    const retryAfter =
      body && typeof body === 'object' && 'retryAfterSeconds' in body
        ? Number((body as { retryAfterSeconds?: number }).retryAfterSeconds)
        : null;
    return new ActiveCampaignRateLimitError(message, Number.isFinite(retryAfter) ? retryAfter : null);
  }
  if (status >= 400 && status < 500) return new ActiveCampaignBadRequestError(status, message);
  return new ActiveCampaignError('API_ERROR', status, message);
}
