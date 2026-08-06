/**
 * Hunter.io API client.
 *
 * - Base URL fixed to `https://api.hunter.io/v2` (no SSRF surface — destination
 *   is hardcoded, callers only supply query params).
 * - Auth via the `X-API-KEY` HTTP header (Hunter supports it alongside the
 *   `api_key` query param). Sending it as a header keeps the secret out of URLs,
 *   logs and referrers (CWE-598) — the key never appears in the request URL.
 * - All Hunter endpoints used here are GET (idempotent) → safe to retry on
 *   transient 403 (rate limit)/5xx with exponential backoff + jitter, honoring
 *   `Retry-After`. 429 (monthly quota) / AUTH_INVALID / BAD_REQUEST are NOT retried.
 * - A `202` from the email-verifier means "still processing": we poll the same
 *   endpoint within the retry budget (Hunter counts all polls as ONE request);
 *   if it never settles, a typed `PENDING` error is surfaced so the agent retries.
 * - Caller cancellation (an aborted `options.signal`) propagates immediately and
 *   is never retried. The per-request timeout is enforced independently via
 *   `AbortSignal.any`, so it still fires even when the caller always supplies a
 *   (never-aborting) signal.
 */

import { classifyHunterError, HunterError } from './errors';

export const HUNTER_BASE_URL = 'https://api.hunter.io/v2';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_AFTER_CAP_MS = 30_000;

export interface HunterFetchOptions {
  apiKey: string;
  searchParams?: Record<string, string | number | undefined>;
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  /** Injectable sleep for deterministic tests. Defaults to a real timer. */
  _sleep?: (ms: number) => Promise<void>;
}

/** Pagination/metadata Hunter returns alongside `data` (e.g. the real total). */
export interface HunterMeta {
  results?: number;
  limit?: number;
  offset?: number;
  params?: Record<string, unknown>;
}

/** Every successful Hunter response is wrapped in `{ data, meta }`. */
export interface HunterEnvelope<T> {
  data: T;
  meta?: HunterMeta;
}

/**
 * Build the request URL from the search params. The api_key is sent as a header
 * (NOT a query param), so it never appears in the URL. Exported for unit tests.
 */
export function buildHunterUrl(
  path: string,
  searchParams: Record<string, string | number | undefined> = {},
): URL {
  const url = new URL(HUNTER_BASE_URL + path);
  for (const [key, value] of Object.entries(searchParams)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

function jitter(): number {
  return Math.round((Math.random() * 2 - 1) * 400); // ±400ms
}

function backoffMs(attempt: number): number {
  // attempt: 0 → ~0.8s, 1 → ~2s, 2 → ~5s (+ jitter)
  const base = [800, 2000, 5000][attempt] ?? 5000;
  return Math.max(0, base + jitter());
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A retryable error is a transient rate-limit (403) or an upstream outage (5xx). */
function isRetryable(err: HunterError): boolean {
  return err.code === 'RATE_LIMITED' || err.code === 'DEPENDENCY_UNAVAILABLE';
}

/**
 * Parse a `Retry-After` header — either a delay in seconds OR an HTTP-date
 * (RFC 7231) — into a millisecond delay clamped to `[0, RETRY_AFTER_CAP_MS]`.
 * Returns `undefined` when the header is absent/unparseable. Exported for tests.
 */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const raw = header.trim();
  if (raw === '') return undefined;

  // Form 1: delay-seconds.
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
  }

  // Form 2: HTTP-date (RFC 7231 IMF-fixdate) — clamp the computed delay to
  // [0, cap]. Gate on a letter (weekday/month/"GMT" always contain letters) so
  // `Date.parse` does not leniently turn malformed numerics like "-5" into a
  // bogus date.
  if (/[a-z]/i.test(raw)) {
    const dateMs = Date.parse(raw);
    if (Number.isFinite(dateMs)) {
      return Math.min(Math.max(0, dateMs - Date.now()), RETRY_AFTER_CAP_MS);
    }
  }

  return undefined;
}

/**
 * Perform a GET against the Hunter API and return the full `{ data, meta }`
 * envelope. Throws a typed `HunterError` on any non-2xx response (and on a
 * persistently `202` email-verifier). Use `hunterGet` when you only need `data`.
 */
export async function hunterGetEnvelope<T = unknown>(
  path: string,
  options: HunterFetchOptions,
): Promise<HunterEnvelope<T>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = options._sleep ?? realSleep;
  const url = buildHunterUrl(path, options.searchParams);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const isLast = attempt === maxRetries;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    // Combine our timeout with the caller's signal so the timeout still aborts
    // the request even when the caller always supplies its own (real) signal.
    const signal = options.signal
      ? AbortSignal.any([timeoutController.signal, options.signal])
      : timeoutController.signal;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json', 'X-API-KEY': options.apiKey },
        signal,
      });
    } catch (err) {
      clearTimeout(timer);
      // Caller-initiated cancellation → propagate immediately, never retry.
      if (options.signal?.aborted) {
        throw err;
      }
      if (isLast) {
        throw new HunterError(
          'DEPENDENCY_UNAVAILABLE',
          err instanceof Error ? err.message : 'Network error contacting Hunter API',
        );
      }
      await sleep(backoffMs(attempt));
      continue;
    } finally {
      clearTimeout(timer);
    }

    // 202 = email-verifier still processing. Poll the same endpoint within the
    // retry budget; if it never settles, surface a typed PENDING.
    if (res.status === 202) {
      await res.text().catch(() => undefined);
      if (!isLast) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new HunterError(
        'PENDING',
        'Hunter is still verifying this email; the result is not ready yet (try again shortly).',
        202,
      );
    }

    if (res.ok) {
      const text = await res.text();
      try {
        const json = JSON.parse(text) as HunterEnvelope<T>;
        return { data: json.data, meta: json.meta };
      } catch {
        throw new HunterError(
          'DEPENDENCY_UNAVAILABLE',
          `Hunter returned a non-JSON body: ${text.slice(0, 120)}`,
          res.status,
        );
      }
    }

    const body = await res.text();
    const error = classifyHunterError(res.status, body);

    if (isRetryable(error) && !isLast) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      await sleep(retryAfter ?? backoffMs(attempt));
      continue;
    }

    throw error;
  }

  // Unreachable: the loop either returns, throws, or exhausts on the last
  // attempt (which always throws). Satisfies the compiler's return analysis.
  throw new HunterError('DEPENDENCY_UNAVAILABLE', 'Hunter request exhausted retries');
}

/**
 * Convenience wrapper returning just the parsed `data` payload — the common
 * case. Use `hunterGetEnvelope` when you also need `meta` (e.g. pagination
 * totals from `meta.results`).
 */
export async function hunterGet<T = unknown>(
  path: string,
  options: HunterFetchOptions,
): Promise<T> {
  const { data } = await hunterGetEnvelope<T>(path, options);
  return data;
}
