/**
 * Pure, side-effect-free helpers for the Google Analytics 4 MCA.
 *
 * Extracted from `index.ts` so they can be unit-tested in isolation without
 * importing the MCA server (which calls `server.start()` on load) or the
 * `googleapis` client. These functions own the parsing/normalization and
 * response-curation contracts that the renderer and the LLM depend on, so
 * they are the highest-value surface to pin with tests.
 */

/**
 * Accept "123456" or "properties/123456" → "properties/123456".
 *
 * The already-prefixed branch is RE-VALIDATED (`^properties\/\d+$`), not passed
 * through verbatim: "properties/abc" or a deeper path like
 * "properties/123/dataStreams/9" is a malformed propertyId that the GA4 API
 * would reject with a 404/400 mid-call — we fail fast at the boundary instead.
 */
export function parsePropertyName(input: string): string {
  const trimmed = String(input).trim();
  if (!trimmed) throw new Error('[INVALID_ARGUMENT] propertyId must be a non-empty string');
  if (/^properties\/\d+$/.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) return `properties/${trimmed}`;
  throw new Error(
    `[INVALID_ARGUMENT] propertyId must be a numeric ID or "properties/{id}", got: ${trimmed}`,
  );
}

/**
 * Accept "123456" or "accounts/123456" → "accounts/123456".
 *
 * The already-prefixed branch is RE-VALIDATED (`^accounts\/\d+$`) for the same
 * reason as {@link parsePropertyName}: "accounts/xyz" is rejected at the
 * boundary rather than forwarded to a guaranteed-to-fail API call.
 */
export function parseAccountName(input: string): string {
  const trimmed = String(input).trim();
  if (!trimmed) throw new Error('[INVALID_ARGUMENT] accountId must be a non-empty string');
  if (/^accounts\/\d+$/.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) return `accounts/${trimmed}`;
  throw new Error(
    `[INVALID_ARGUMENT] accountId must be a numeric ID or "accounts/{id}", got: ${trimmed}`,
  );
}

/**
 * Validate a bare numeric GA4 data-stream id (the trailing segment of a
 * `properties/{p}/dataStreams/{s}` resource name). GA4 stream ids are numeric;
 * anything else is rejected at the boundary (`^\d+$`).
 */
export function parseStreamId(input: string): string {
  const trimmed = String(input).trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('[INVALID_ARGUMENT] streamId must be a numeric ID');
  }
  return trimmed;
}

/** Strip "properties/" prefix to get the bare numeric ID for display. */
export function propertyIdOf(name?: string | null): string | undefined {
  if (!name) return undefined;
  const m = String(name).match(/^properties\/(\d+)$/);
  return m ? m[1] : String(name);
}

/** Strip "accounts/" prefix. */
export function accountIdOf(name?: string | null): string | undefined {
  if (!name) return undefined;
  const m = String(name).match(/^accounts\/(\d+)$/);
  return m ? m[1] : String(name);
}

/** Whitelist helper: pick only declared keys, omit nulls. */
export function pick<T extends object, K extends keyof T>(
  obj: T | undefined | null,
  keys: K[],
): Pick<T, K> | undefined {
  if (!obj) return undefined;
  const out = {} as Pick<T, K>;
  for (const k of keys) {
    const v = (obj as any)[k];
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/**
 * Read an HTTP status off a gaxios/googleapis error robustly. Recent gaxios
 * sets `err.code` to a STRING (`"ERR_BAD_REQUEST"`, `"ETIMEDOUT"`) and carries
 * the numeric status on `err.status` / `err.response.status`, while older
 * versions put the number on `err.code`. We try, in order: `status`,
 * `response.status`, then a numeric `code` — a string `code` is NOT a status.
 */
export function statusOf(err: any): number | undefined {
  return (
    err?.status ??
    err?.response?.status ??
    (typeof err?.code === 'number' ? err.code : undefined)
  );
}

/** Map Google API errors to IssueCode-prefixed messages so the LLM can act on them. */
export function mapAnalyticsError(err: any): never {
  const status = statusOf(err);
  const message = err?.message || err?.response?.data?.error?.message || 'Google Analytics API error';
  if (status === 401) throw new Error(`[AUTH_EXPIRED] ${message}`);
  if (status === 403) {
    if (/quota|rate/i.test(message)) throw new Error(`[RATE_LIMITED] ${message}`);
    if (/scope|permission/i.test(message)) throw new Error(`[INSUFFICIENT_SCOPE] ${message}`);
    throw new Error(`[FORBIDDEN] ${message}`);
  }
  if (status === 404) throw new Error(`[NOT_FOUND] ${message}`);
  if (status === 429) throw new Error(`[RATE_LIMITED] ${message}`);
  if (typeof status === 'number' && status >= 500) {
    throw new Error(`[DEPENDENCY_UNAVAILABLE] ${message}`);
  }
  if (status === 400) throw new Error(`[INVALID_ARGUMENT] ${message}`);
  // No HTTP status resolved. Transport failures (DNS, refused, reset, timeout)
  // surface a STRING `err.code` (ENOTFOUND, ECONNREFUSED, ECONNRESET,
  // ETIMEDOUT, EAI_AGAIN…). That is a transient dependency outage the LLM can
  // retry — not a logic `[UNKNOWN]` it should give up on.
  if (status === undefined && typeof err?.code === 'string') {
    throw new Error(`[DEPENDENCY_UNAVAILABLE] ${message}`);
  }
  throw new Error(`[UNKNOWN] ${message}`);
}

/** Curate a runReport response to a structured shape ready for the renderer. */
export function curateReport(response: any) {
  const dimensionHeaders = (response.dimensionHeaders || []).map((h: any) => ({ name: h.name }));
  const metricHeaders = (response.metricHeaders || []).map((h: any) => ({
    name: h.name,
    type: h.type,
  }));
  const rows = (response.rows || []).map((row: any) => ({
    dimensionValues: (row.dimensionValues || []).map((d: any) => d.value),
    metricValues: (row.metricValues || []).map((m: any) => m.value),
  }));
  return {
    dimensionHeaders,
    metricHeaders,
    rows,
    rowCount: response.rowCount ?? rows.length,
    totals: response.totals?.map((t: any) => t.metricValues?.map((v: any) => v.value)),
    minimums: response.minimums?.map((t: any) => t.metricValues?.map((v: any) => v.value)),
    maximums: response.maximums?.map((t: any) => t.metricValues?.map((v: any) => v.value)),
    metadata: response.metadata
      ? { currencyCode: response.metadata.currencyCode, timeZone: response.metadata.timeZone }
      : undefined,
    propertyQuota: response.propertyQuota,
  };
}

/** Raw report args as they arrive from the tool call (pre-normalization). */
export interface RawReportArgs {
  dimensions?: string[];
  metrics?: string[];
  dateRanges?: Array<{ startDate: string; endDate: string; name?: string }>;
  dimensionFilter?: unknown;
  metricFilter?: unknown;
  orderBys?: unknown;
  limit?: number | string;
  offset?: number | string;
  keepEmptyRows?: boolean;
  returnPropertyQuota?: boolean;
  currencyCode?: string;
  metricAggregations?: string[];
}

/**
 * Build a GA4 report request body from raw tool args. PURE — owns the
 * normalization EVERY report path must apply identically, so `run-report`,
 * `run-realtime-report`, and each sub-request of `batch-run-reports` stay in
 * lockstep:
 *
 *  - `dimensions`/`metrics`: `string[]` → `[{ name }]`. GA4 rejects bare
 *    strings with `400 INVALID_ARGUMENT` — this is exactly the bug
 *    `batch-run-reports` had by forwarding `requests` raw.
 *  - `limit`/`offset`: coerced to STRING (GA4's wire format is int64-as-string).
 *    Guarded with `!= null` (not truthiness) so `0`/`100` survive as `"0"`/`"100"`.
 *  - `metrics` must be non-empty (always); `dateRanges` non-empty (non-realtime
 *    only). Both throw `[INVALID_ARGUMENT]` at the boundary.
 *
 * Realtime reports share dimensions/metrics/filters/orderBys/limit but have NO
 * `dateRanges`/`offset`/`keepEmptyRows`/`currencyCode`/`metricAggregations`.
 */
export function buildReportRequest(
  args: RawReportArgs,
  options: { realtime?: boolean } = {},
): Record<string, unknown> {
  const dimensions = (args.dimensions ?? []).map((name) => ({ name }));
  const metrics = (args.metrics ?? []).map((name) => ({ name }));
  if (metrics.length === 0) {
    throw new Error('[INVALID_ARGUMENT] metrics must contain at least one entry');
  }

  const body: Record<string, unknown> = {
    dimensions,
    metrics,
    dimensionFilter: args.dimensionFilter,
    metricFilter: args.metricFilter,
    orderBys: args.orderBys,
    limit: args.limit != null ? String(args.limit) : undefined,
    returnPropertyQuota: args.returnPropertyQuota,
  };

  if (options.realtime) return body;

  if (!args.dateRanges?.length) {
    throw new Error('[INVALID_ARGUMENT] dateRanges must contain at least one entry');
  }
  body.dateRanges = args.dateRanges;
  body.offset = args.offset != null ? String(args.offset) : undefined;
  body.keepEmptyRows = args.keepEmptyRows;
  body.currencyCode = args.currencyCode;
  body.metricAggregations = args.metricAggregations;
  return body;
}

/** Health-check issue codes this MCA raises from the accounts probe. */
type HealthProbeCode = 'RATE_LIMITED' | 'AUTH_EXPIRED' | 'DEPENDENCY_UNAVAILABLE' | 'USER_CONFIG_MISSING';

export interface HealthProbeIssue {
  code: HealthProbeCode;
  message: string;
  action: { type: 'user_action' | 'auto_retry'; description: string };
}

/**
 * Classify the GA4 accounts-probe outcome into a health issue (or `null` when
 * healthy). PURE so the health-check decision is unit-testable without the SDK.
 *
 *  - error 403 + quota/rate wording → `RATE_LIMITED` (auto_retry). Do NOT flatten
 *    a quota 403 to `AUTH_EXPIRED`: telling the user to reconnect burns a
 *    reconnect on a transient quota cap (the TER-222 failure mode).
 *  - error 401/403 (auth/scope) → `AUTH_EXPIRED` (reconnect).
 *  - any other error → `DEPENDENCY_UNAVAILABLE` (auto_retry).
 *  - 0 accounts visible → `USER_CONFIG_MISSING` (OAuth worked, no GA access).
 */
export function classifyAccountsProbe(
  result: { accountCount: number } | { error: unknown },
): HealthProbeIssue | null {
  if ('error' in result) {
    const err = result.error as any;
    const status = statusOf(err);
    const message = err?.message || 'Google Analytics API error';
    if (status === 403 && /quota|rate/i.test(message)) {
      return {
        code: 'RATE_LIMITED',
        message: 'Google Analytics API quota or rate limit reached',
        action: { type: 'auto_retry', description: 'Retry after the quota window resets' },
      };
    }
    if (status === 401 || status === 403) {
      return {
        code: 'AUTH_EXPIRED',
        message: 'Google Analytics access token expired, revoked, or missing scopes',
        action: { type: 'user_action', description: 'Reconnect your Google account' },
      };
    }
    return {
      code: 'DEPENDENCY_UNAVAILABLE',
      message: `Google Analytics API error: ${message}`,
      action: { type: 'auto_retry', description: 'Google Analytics API temporarily unavailable' },
    };
  }
  if (result.accountCount === 0) {
    return {
      code: 'USER_CONFIG_MISSING',
      message: 'OAuth succeeded but no GA accounts are accessible to this user',
      action: {
        type: 'user_action',
        description:
          'Ensure your Google account has access to at least one Google Analytics account',
      },
    };
  }
  return null;
}
