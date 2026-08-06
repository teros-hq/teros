import type { ToolContext } from '@teros/mca-sdk';
import { safeFetch, withTimeout } from '@teros/mca-sdk';
import { ActiveCampaignError, ActiveCampaignRateLimitError, classifyAcError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT = 'Teros-MCA-ActiveCampaign/1.0';
const MAX_GET_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 800;
const MAX_RETRY_DELAY_MS = 30_000;
/** ActiveCampaign accounts are always served over https on 443. */
const ALLOWED_PORTS = [443];

export interface AcRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  searchParams?: Record<string, string | number | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

interface AcCredentials {
  baseUrl: string;
  apiToken: string;
}

// ── Test seams ──────────────────────────────────────────────────────────────
// The SSRF guard resolves DNS and the retry path sleeps; both are slow/flaky in
// unit tests. These seams let tests inject a fake resolver (so `safeFetch` never
// touches the network) and a no-op sleep (so retry tests are instant). Left
// `undefined` in production → real DNS + real backoff.
type ResolveHost = (host: string) => Promise<Array<{ address: string }>>;
let testResolveHost: ResolveHost | undefined;
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let sleepImpl: (ms: number) => Promise<void> = realSleep;

export function __setAcResolveHostForTests(fn: ResolveHost | undefined): void {
  testResolveHost = fn;
}
export function __setAcSleepForTests(fn: ((ms: number) => Promise<void>) | undefined): void {
  sleepImpl = fn ?? realSleep;
}

async function loadCredentials(context: ToolContext): Promise<AcCredentials> {
  let userSecrets: Record<string, string> = {};
  try {
    userSecrets = (await context.getUserSecrets()) ?? {};
  } catch {
    userSecrets = {};
  }
  const baseUrl = (userSecrets.ACTIVECAMPAIGN_BASE_URL ?? '').trim().replace(/\/+$/, '');
  const apiToken = (userSecrets.ACTIVECAMPAIGN_API_TOKEN ?? '').trim();
  if (!baseUrl) {
    throw new ActiveCampaignError(
      'AUTH_INVALID',
      0,
      'ACTIVECAMPAIGN_BASE_URL not configured (e.g. https://youraccount.api-us1.com)',
    );
  }
  if (!apiToken) {
    throw new ActiveCampaignError('AUTH_INVALID', 0, 'ACTIVECAMPAIGN_API_TOKEN not configured');
  }
  // AC tokens are alphanumeric; reject embedded whitespace/CR-LF so a malformed
  // secret fails with a clear message instead of an opaque header error.
  if (/\s/.test(apiToken)) {
    throw new ActiveCampaignError(
      'AUTH_INVALID',
      0,
      'ACTIVECAMPAIGN_API_TOKEN contains invalid whitespace characters',
    );
  }
  // Reject a malformed or non-https base URL early with a clear message. The
  // per-request SSRF guard (`safeFetch`) still blocks private/internal hosts
  // even if this check is loosened — this is the friendly first line of defence.
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ActiveCampaignError(
      'AUTH_INVALID',
      0,
      'ACTIVECAMPAIGN_BASE_URL is not a valid URL (e.g. https://youraccount.api-us1.com)',
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new ActiveCampaignError(
      'AUTH_INVALID',
      0,
      'ACTIVECAMPAIGN_BASE_URL must use https (e.g. https://youraccount.api-us1.com)',
    );
  }
  return { baseUrl, apiToken };
}

function buildUrl(
  baseUrl: string,
  path: string,
  searchParams?: AcRequestOptions['searchParams'],
): string {
  const trimmedPath = path.startsWith('/') ? path : `/${path}`;
  const fullPath = trimmedPath.startsWith('/api/') ? trimmedPath : `/api/3${trimmedPath}`;
  const url = new URL(fullPath, baseUrl);
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function parseResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  const text = await response.text().catch(() => '');
  return text || null;
}

async function rawRequest(
  credentials: AcCredentials,
  path: string,
  options: AcRequestOptions,
): Promise<unknown> {
  const { method = 'GET', searchParams, body, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const url = buildUrl(credentials.baseUrl, path, searchParams);

  const headers: Record<string, string> = {
    'Api-Token': credentials.apiToken,
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  };
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
  }

  // SSRF guard: `safeFetch` resolves the host and rejects loopback / private /
  // link-local (incl. 169.254.169.254) / internal addresses, and re-validates
  // every redirect hop. The base URL is a user-supplied secret, so without this
  // the `Api-Token` header could be sent to an internal host.
  const response = await withTimeout(
    () =>
      safeFetch(
        url,
        {
          method,
          headers,
          body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
        },
        { allowedPorts: ALLOWED_PORTS, resolveHost: testResolveHost },
      ),
    timeoutMs,
  );

  if (!response.ok) {
    const errorBody = await parseResponseBody(response);
    // 429 is handled here (not in `classifyAcError`) because the wait hint lives
    // in the `Retry-After` *header*, which the classifier never sees.
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const retryAfterSeconds = retryAfter ? Number(retryAfter) : null;
      throw new ActiveCampaignRateLimitError(
        `Rate limited by ActiveCampaign API`,
        retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
      );
    }
    throw classifyAcError(response.status, errorBody);
  }

  return parseResponseBody(response);
}

/** Retryable transient failures for idempotent GETs only. */
function isRetryableGetError(err: unknown): boolean {
  if (err instanceof ActiveCampaignRateLimitError) return true;
  if (err instanceof ActiveCampaignError) return err.status >= 500;
  const msg = err instanceof Error ? err.message : '';
  return /ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|timed out/i.test(msg);
}

/** Honour the server's `Retry-After` on 429 (clamped to 30s); otherwise back off
 *  exponentially from the base delay. */
function retryDelayMs(err: unknown, attempt: number): number {
  if (
    err instanceof ActiveCampaignRateLimitError &&
    err.retryAfterSeconds !== null &&
    err.retryAfterSeconds > 0
  ) {
    return Math.min(err.retryAfterSeconds * 1000, MAX_RETRY_DELAY_MS);
  }
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

export async function acRequest(
  context: ToolContext,
  path: string,
  options: AcRequestOptions = {},
): Promise<unknown> {
  const credentials = await loadCredentials(context);
  const method = options.method ?? 'GET';

  // Mutations: no retry — POST/PUT/DELETE without idempotency keys could duplicate.
  if (method !== 'GET') {
    return rawRequest(credentials, path, options);
  }

  // Idempotent GETs: retry transient failures with backoff, honouring Retry-After.
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_GET_RETRIES; attempt++) {
    try {
      return await rawRequest(credentials, path, options);
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_GET_RETRIES || !isRetryableGetError(err)) throw err;
      await sleepImpl(retryDelayMs(err, attempt));
    }
  }
  throw lastErr;
}

export async function acPing(context: ToolContext): Promise<void> {
  // Lightweight probe used by health-check.
  await acRequest(context, '/users/me', { timeoutMs: 8_000 });
}
