/**
 * HTTP client for mca.make.
 *
 * Two surfaces:
 *   1. Webhook trigger — POST to a user-supplied `*.make.com` webhook URL. No
 *      account credentials. POST is NEVER retried (no idempotency key → a retry
 *      could double-run the scenario). The tokenized URL is NEVER echoed in
 *      errors — only the host is surfaced (the token lives in the path).
 *   2. Account API — `https://<region>.make.com/api/v2` with
 *      `Authorization: Token <MAKE_API_TOKEN>`. GETs retry transient 429/5xx
 *      (idempotent); POST/PATCH/DELETE do not.
 *
 * Network calls go through the global `fetch`. A `fetchImpl` override exists for
 * deterministic unit testing — production passes nothing and uses `fetch`.
 */

import { withTimeout } from '@teros/mca-sdk';
import { extractMakeApiMessage, MakeError, makeErrorFromStatus, truncate } from './errors';
import { parseMakeWebhookUrl } from './url-guard';

export const MAKE_REGIONS = ['eu1', 'eu2', 'us1', 'us2'] as const;
export type MakeRegion = (typeof MAKE_REGIONS)[number];
export const DEFAULT_REGION: MakeRegion = 'eu1';

const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT = 'Teros-MCA-Make/2.0';

// ─── GET retry tuning (idempotent reads only — mutating methods are never retried) ──────
const MAX_GET_RETRIES = 2;
/** Exponential-ish backoff schedule (ms) per attempt, jittered below. */
const RETRY_BACKOFF_MS = [800, 2000, 5000];
/** `Retry-After` is honored but clamped so a hostile/buggy header can't hang us. */
const RETRY_AFTER_CAP_MS = 30_000;
const JITTER_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Additive jitter (mirrors figma-client). Capped to the base delay so the tiny
 * delays used in unit tests stay near-instant while production delays (≥800ms)
 * still get the full ±400ms spread that de-correlates concurrent retriers.
 */
function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * Math.min(JITTER_MS, Math.max(1, ms)));
}

/** Parse a `Retry-After` header (seconds) into ms, clamped to 30s. null when absent/invalid. */
export function parseRetryAfterMs(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const secs = Number.parseInt(raw, 10);
  if (!Number.isFinite(secs) || secs < 0) return null;
  return Math.min(RETRY_AFTER_CAP_MS, secs * 1000);
}

/** Minimal structural shape of `fetch` — avoids depending on `fetch.preconnect` etc. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Validate a region string. Empty → default `eu1`. Unknown → `[BAD_REQUEST]`
 * (the user mis-configured `MAKE_REGION`). Case-insensitive.
 */
export function normalizeRegion(region?: string | null): MakeRegion {
  const r = (region ?? '').trim().toLowerCase();
  if (r.length === 0) return DEFAULT_REGION;
  if ((MAKE_REGIONS as readonly string[]).includes(r)) return r as MakeRegion;
  throw new MakeError(
    'BAD_REQUEST',
    `Invalid MAKE_REGION "${region}". Expected one of: ${MAKE_REGIONS.join(', ')}`,
  );
}

// ─── Webhook trigger (POST — never retried) ─────────────────────────────────

export interface TriggerWebhookResult {
  delivered: boolean;
  statusCode: number;
  webhookHost: string;
  region: string | null;
  responseType: 'json' | 'text';
  response: unknown;
}

/**
 * Serialize the webhook payload. Objects/arrays → `application/json`. A string
 * that is valid JSON is forwarded as-is (`application/json`, trimmed); any other
 * string is sent raw as `text/plain`.
 */
export function serializeWebhookPayload(payload: unknown): { body: string; contentType: string } {
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (trimmed.length === 0) return { body: '', contentType: 'text/plain' };
    try {
      JSON.parse(trimmed);
      return { body: trimmed, contentType: 'application/json' };
    } catch {
      return { body: payload, contentType: 'text/plain' };
    }
  }
  return { body: JSON.stringify(payload ?? {}), contentType: 'application/json' };
}

export interface TriggerWebhookOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

export async function triggerWebhook(
  rawUrl: string,
  payload: unknown,
  opts: TriggerWebhookOptions = {},
): Promise<TriggerWebhookResult> {
  // SSRF guard runs BEFORE any network access — a bad host never reaches fetch.
  const { url, host, region } = parseMakeWebhookUrl(rawUrl);
  const { body, contentType } = serializeWebhookPayload(payload);
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await withTimeout(
      () =>
        doFetch(url, {
          method: 'POST',
          headers: { 'content-type': contentType, 'user-agent': USER_AGENT },
          body,
          signal: opts.signal,
          // SSRF: a legitimate Make webhook never redirects. `redirect:'error'`
          // makes fetch THROW on a 3xx instead of silently following the
          // `Location` (which a hostile webhook could point at an internal host
          // like 169.254.169.254 — the guard only validated the INITIAL host).
          redirect: 'error',
        }),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  } catch (err) {
    // Redacted: report the host only. `err.message` can itself echo the
    // tokenized URL (Node's fetch errors include it), so scrub it explicitly —
    // never surface the path token (it grants scenario-trigger access).
    const detail = err instanceof Error ? redactWebhookUrl(err.message, url, host) : 'network error';
    throw new MakeError('DEPENDENCY_UNAVAILABLE', `Failed to reach Make webhook host ${host}: ${detail}`);
  }

  const text = await res.text();
  if (res.status >= 400) {
    // Redacted: host + status + body snippet, never the tokenized URL (the
    // body itself could echo the request URL — scrub before truncating).
    throw makeErrorFromStatus(
      res.status,
      `Make webhook ${host} returned ${res.status}: ${truncate(redactWebhookUrl(text, url, host), 200)}`,
    );
  }

  const { value, type } = parseBody(text);
  return {
    delivered: true,
    statusCode: res.status,
    webhookHost: host,
    region,
    responseType: type,
    response: value,
  };
}

function parseBody(text: string): { value: unknown; type: 'json' | 'text' } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { value: '', type: 'text' };
  try {
    return { value: JSON.parse(trimmed), type: 'json' };
  } catch {
    return { value: text, type: 'text' };
  }
}

/**
 * Scrub the tokenized webhook URL out of an arbitrary message before it is
 * surfaced. The webhook token lives in the URL path/query; an underlying
 * network error (or the response body) may echo the full URL, so we replace
 * both the full URL and the bare path-token with a host-only placeholder.
 */
function redactWebhookUrl(message: string, url: string, host: string): string {
  let out = message.split(url).join(`https://${host}/<redacted>`);
  try {
    const u = new URL(url);
    const token = `${u.pathname}${u.search}`.replace(/^\/+/, '');
    if (token.length >= 4) out = out.split(token).join('<redacted>');
  } catch {
    // url was validated upstream; nothing to redact if it fails to re-parse.
  }
  return out;
}

// ─── Account API (Authorization: Token) ─────────────────────────────────────

export interface AccountApiOptions {
  apiKey: string;
  region: MakeRegion;
  searchParams?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Initial retry backoff (GET only). Exposed for deterministic tests; defaults to 800ms. */
  retryDelayMs?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

export interface RawAccountResponse {
  status: number;
  text: string;
  /** Parsed `Retry-After` (ms, clamped 30s) when present — drives GET backoff. */
  retryAfterMs: number | null;
}

/** Account API methods. GET is idempotent and retried; mutating methods are not. */
export type AccountApiMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * Single raw request to the Make account API. Returns the status + body for any
 * HTTP response (incl. 4xx/5xx) so callers can interpret the status (the
 * health-check probe wants the raw status; `accountApiJson` maps errors).
 *
 * It DOES throw a coded `MakeError('DEPENDENCY_UNAVAILABLE')` on transport
 * failure — network error, timeout (the request is bounded by `timeoutMs`), or
 * an unexpected redirect (`redirect:'error'`). Surfacing those as a coded error
 * (vs a bare `TypeError: fetch failed`) lets the LLM read the `[CODE]` and the
 * GET retry loop recognize them as transient.
 */
export async function accountApiRaw(
  method: AccountApiMethod,
  path: string,
  opts: AccountApiOptions,
): Promise<RawAccountResponse> {
  const url = new URL(`https://${opts.region}.make.com/api/v2${path}`);
  for (const [k, v] of Object.entries(opts.searchParams ?? {})) url.searchParams.set(k, v);

  const headers: Record<string, string> = {
    authorization: `Token ${opts.apiKey}`,
    accept: 'application/json',
    'user-agent': USER_AGENT,
  };
  // redirect:'error' — the Make REST API never legitimately redirects; following
  // one would defeat the region pinning (SSRF defense-in-depth; the auth token
  // rides in the header so it would also leak to the redirect target).
  const init: RequestInit = { method, headers, redirect: 'error', signal: opts.signal };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let res: Response;
  try {
    res = await withTimeout(() => doFetch(url, init), timeout);
  } catch (err) {
    if (err instanceof MakeError) throw err;
    throw new MakeError(
      'DEPENDENCY_UNAVAILABLE',
      `Failed to reach Make API (${method} ${path}): ${err instanceof Error ? err.message : 'network error'}`,
    );
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new MakeError(
      'DEPENDENCY_UNAVAILABLE',
      `Failed to read Make API response (${method} ${path}): ${err instanceof Error ? err.message : 'read error'}`,
    );
  }

  return { status: res.status, text, retryAfterMs: parseRetryAfterMs(res) };
}

/** Base backoff for a GET retry attempt (tests override via `retryDelayMs`). */
function backoffMs(attempt: number, opts: AccountApiOptions): number {
  return opts.retryDelayMs ?? RETRY_BACKOFF_MS[attempt] ?? 5000;
}

function parseAccountJson<T>(text: string): T {
  if (text.trim().length === 0) return undefined as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new MakeError('UPSTREAM_ERROR', `Make API returned non-JSON body: ${truncate(text, 120)}`);
  }
}

/**
 * Request the account API and parse JSON, mapping HTTP errors to `MakeError`.
 *
 * GET is idempotent → retries transient failures (429, 5xx, network/timeout)
 * up to {@link MAX_GET_RETRIES} times with exponential backoff + jitter,
 * honoring a `Retry-After` header (clamped 30s) when the server sends one.
 * POST/PATCH/DELETE are executed exactly once — without an idempotency key a
 * retried mutation could create, update, or delete state twice.
 */
export async function accountApiJson<T>(
  method: AccountApiMethod,
  path: string,
  opts: AccountApiOptions,
): Promise<T> {
  if (method !== 'GET') {
    const { status, text } = await accountApiRaw(method, path, opts);
    if (status >= 400) throw makeErrorFromStatus(status, extractMakeApiMessage(text, status));
    return parseAccountJson<T>(text);
  }

  for (let attempt = 0; ; attempt++) {
    let raw: RawAccountResponse;
    try {
      raw = await accountApiRaw(method, path, opts);
    } catch (err) {
      // Network/timeout/redirect surfaced as coded MakeError by accountApiRaw.
      const transient =
        err instanceof MakeError &&
        (err.code === 'DEPENDENCY_UNAVAILABLE' || err.code === 'RATE_LIMITED');
      if (transient && attempt < MAX_GET_RETRIES) {
        await sleep(jitter(backoffMs(attempt, opts)));
        continue;
      }
      throw err;
    }

    if (raw.status < 400) return parseAccountJson<T>(raw.text);

    const transient = raw.status === 429 || raw.status >= 500;
    if (transient && attempt < MAX_GET_RETRIES) {
      await sleep(jitter(raw.retryAfterMs ?? backoffMs(attempt, opts)));
      continue;
    }
    throw makeErrorFromStatus(raw.status, extractMakeApiMessage(raw.text, raw.status));
  }
}
