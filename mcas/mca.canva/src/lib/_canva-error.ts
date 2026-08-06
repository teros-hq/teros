/**
 * Canva API error classification.
 *
 * Maps HTTP status + body to (IssueCode + IssueAction). The `message` field
 * is the LITERAL upstream Canva message — never re-tuned. Only `description`
 * (action) is curated per code. Pattern from TER-222 (`_google-error.ts`).
 */

export type IssueCode =
  | 'AUTH_EXPIRED'
  | 'AUTH_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'VALIDATION_ERROR'
  | 'PROVIDER_ERROR'
  | 'NETWORK_ERROR'
  | 'CONFIG_MISSING';

export interface IssueAction {
  type: 'user_action' | 'admin_action' | 'auto_retry';
  description: string;
}

export interface ClassifiedCanvaError {
  code: IssueCode;
  action: IssueAction;
  /** Literal upstream Canva message. Never edited. */
  message: string;
}

function extractCanvaMessage(body: unknown, fallback: string): string {
  if (typeof body === 'string') return body || fallback;
  if (body && typeof body === 'object') {
    const b = body as {
      message?: string;
      error_description?: string;
      error?: string;
      code?: string;
    };
    // Order matters: Canva uses `message` (rest API), `error_description`
    // (OAuth), `error` (some 5xx responses like 501 on unsupported filters),
    // and `code` as last resort. Without `error` we'd surface raw JSON to
    // the caller for those 5xx paths.
    return b.message || b.error_description || b.error || b.code || fallback;
  }
  return fallback;
}

export function classifyCanvaApiError(
  status: number,
  body: unknown,
  fallbackMessage = 'Canva API error',
): ClassifiedCanvaError {
  const message = extractCanvaMessage(body, fallbackMessage);

  if (status === 401) {
    return {
      code: 'AUTH_EXPIRED',
      action: { type: 'user_action', description: 'Reconnect your Canva account.' },
      message,
    };
  }
  if (status === 403) {
    return {
      code: 'PERMISSION_DENIED',
      action: {
        type: 'user_action',
        description:
          'Verify the Canva account has the required scope (e.g. brandtemplate:meta:read for brand templates, comment:write for threads).',
      },
      message,
    };
  }
  if (status === 404) {
    return {
      code: 'NOT_FOUND',
      action: {
        type: 'user_action',
        description: 'Resource not found — check the ID or whether it was moved/deleted.',
      },
      message,
    };
  }
  if (status === 429) {
    return {
      code: 'RATE_LIMITED',
      action: { type: 'auto_retry', description: 'Canva rate limit; retry after a short delay.' },
      message,
    };
  }
  if (status === 400 || status === 422) {
    return {
      code: 'VALIDATION_ERROR',
      action: { type: 'user_action', description: 'Request rejected by Canva — see message.' },
      message,
    };
  }
  if (status >= 500) {
    return {
      code: 'PROVIDER_ERROR',
      action: { type: 'auto_retry', description: 'Canva API temporarily unavailable.' },
      message,
    };
  }
  return {
    code: 'PROVIDER_ERROR',
    action: { type: 'auto_retry', description: 'Unknown Canva API error.' },
    message,
  };
}

/** Thrown by `canvaRequest` on non-OK responses. Carries classification. */
export class CanvaApiError extends Error {
  status: number;
  classified: ClassifiedCanvaError;

  constructor(status: number, classified: ClassifiedCanvaError) {
    super(`Canva API error (${status}): ${classified.message}`);
    this.name = 'CanvaApiError';
    this.status = status;
    this.classified = classified;
  }
}
