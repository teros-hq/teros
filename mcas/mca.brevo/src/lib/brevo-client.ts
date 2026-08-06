/**
 * Brevo API client.
 *
 * Stateless: the API key is read from `context.getUserSecrets()` on every call
 * (per-app container → each user's own key). Auth is the `api-key` HEADER
 * (NOT Bearer). Destination is the fixed host `api.brevo.com`, so a plain
 * `fetch` is safe — no SSRF surface, no `safeFetch` needed.
 *
 * Retries (criterion 18 / CLAUDE.md §14.10): only idempotent GETs are retried
 * on transient errors (429/5xx) with exponential backoff + jitter, honoring
 * `Retry-After` clamped to 30s. POST/PUT/DELETE are NEVER retried — without an
 * idempotency key a retry would duplicate emails / contacts.
 */

import type { ToolContext } from '@teros/mca-sdk';
import { BrevoApiError, classifyBrevoError } from './_brevo-error';

const BREVO_API_BASE = 'https://api.brevo.com/v3';
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_GET_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 30_000;

export interface BrevoRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query params — `undefined`/`null` values are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** JSON request body (object). Serialized with JSON.stringify. */
  body?: unknown;
}

async function getApiKey(context: ToolContext): Promise<string> {
  let secrets: Record<string, string> = {};
  try {
    secrets = await context.getUserSecrets();
  } catch {
    // fall through to the missing-key error below
  }
  // Canonical secret name only. The manifest declares `BREVO_API_KEY`, so a
  // lowercase `brevo_api_key` fallback never matches a stored secret AND would
  // diverge from the health-check, which keys solely on `BREVO_API_KEY`.
  const key = secrets.BREVO_API_KEY;
  if (!key || key.trim().length === 0) {
    throw new BrevoApiError('AUTH_INVALID', 401, 'Brevo API key not configured.', {
      type: 'user_action',
      description:
        'Add your Brevo API key in the app settings (Brevo → Settings → SMTP & API → API Keys).',
    });
  }
  return key.trim();
}

function buildUrl(endpoint: string, query?: BrevoRequestOptions['query']): string {
  const url = new URL(`${BREVO_API_BASE}${endpoint}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    }
  }
  const base = 800 * 2 ** attempt; // 0.8s, 1.6s, ...
  const jitter = Math.floor(Math.random() * 400);
  return Math.min(base + jitter, MAX_RETRY_AFTER_MS);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function parseSuccessBody<T>(response: Response): Promise<T> {
  if (response.status === 204) return {} as T;
  const text = await response.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export async function brevoRequest<T = unknown>(
  context: ToolContext,
  endpoint: string,
  options: BrevoRequestOptions = {},
): Promise<T> {
  const apiKey = await getApiKey(context);
  const method = options.method ?? 'GET';
  const url = buildUrl(endpoint, options.query);

  const headers: Record<string, string> = {
    'api-key': apiKey,
    accept: 'application/json',
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const doFetch = (): Promise<Response> =>
    fetch(url, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: context.signal,
    });

  const maxAttempts = method === 'GET' ? MAX_GET_RETRIES + 1 : 1;
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await doFetch();
    if (response.ok) return parseSuccessBody<T>(response);

    lastResponse = response;
    const canRetry = attempt < maxAttempts - 1 && RETRYABLE_STATUS.has(response.status);
    if (!canRetry) break;
    await sleep(backoffMs(attempt, response.headers.get('retry-after')));
  }

  // Non-OK after (optional) retries → classify + throw.
  const response = lastResponse as Response;
  const raw = await response.text();
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // keep raw text for the message
  }
  const classified = classifyBrevoError(response.status, parsed);
  throw new BrevoApiError(
    classified.code,
    response.status,
    classified.message,
    classified.action,
  );
}
