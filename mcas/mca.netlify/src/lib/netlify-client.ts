/**
 * Netlify REST API client (file-digest deploy flow).
 *
 * Every request goes through `safeFetch` from `@teros/mca-sdk` — SSRF-safe: it
 * resolves the host and rejects private/internal addresses, and re-validates
 * each redirect hop. `api.netlify.com` is public, so normal traffic passes; the
 * guard exists so a future config/redirect can't be coerced into hitting an
 * internal address.
 *
 * Errors are surfaced as `NetlifyApiError` with the upstream message preserved
 * LITERALLY and the `message` prefixed with `[CODE]` (SDK-wide convention) so
 * the agent can branch on `[AUTH_INVALID]` / `[RATE_LIMITED]` / `[NOT_FOUND]`.
 */

import { safeFetch } from '@teros/mca-sdk';

export const NETLIFY_API_BASE = 'https://api.netlify.com/api/v1';

export type NetlifyErrorCode =
  | 'AUTH_INVALID'
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'REQUEST_FAILED'
  | 'NETWORK_ERROR'
  | 'CANCELLED';

/** Per-page size for paginated list endpoints (Netlify max is 100). */
export const SITES_PER_PAGE = 100;
/** Safety cap so a misbehaving API can never spin the pager forever. */
export const MAX_SITES_PAGES = 50;

export class NetlifyApiError extends Error {
  readonly code: NetlifyErrorCode;
  readonly httpStatus?: number;
  /** Upstream message, unmodified (the `[CODE]` prefix lives on `message`). */
  readonly upstreamMessage: string;

  constructor(code: NetlifyErrorCode, upstreamMessage: string, httpStatus?: number) {
    super(`[${code}] ${upstreamMessage}`);
    this.name = 'NetlifyApiError';
    this.code = code;
    this.upstreamMessage = upstreamMessage;
    this.httpStatus = httpStatus;
  }
}

export interface NetlifySite {
  id: string;
  name: string;
  url?: string;
  ssl_url?: string;
}

export interface NetlifyDeploy {
  id: string;
  state: string;
  site_id?: string;
  /** SHA1s the API still needs uploaded. May be empty. */
  required?: string[];
  /** Site primary HTTPS URL (published deploys). */
  ssl_url?: string;
  /** Per-deploy permalink HTTPS URL (e.g. https://<id>--site.netlify.app). */
  deploy_ssl_url?: string;
  error_message?: string | null;
}

export interface NetlifyUser {
  id: string;
  email?: string;
  full_name?: string;
}

export function classify(status: number): NetlifyErrorCode {
  if (status === 401 || status === 403) return 'AUTH_INVALID';
  if (status === 404) return 'NOT_FOUND';
  if (status === 422) return 'INVALID_REQUEST';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UPSTREAM_ERROR';
  return 'REQUEST_FAILED';
}

/**
 * Collect every page of a list endpoint. Stops at the first short/empty page
 * (`< perPage` items) — the standard "no more pages" signal — and is bounded by
 * `maxPages` so a server that keeps returning full pages can't loop forever.
 *
 * Pure (the page fetcher is injected) so the pagination contract is unit-testable
 * without a live API.
 */
export async function collectPages<T>(
  fetchPage: (page: number, perPage: number) => Promise<T[]>,
  perPage: number = SITES_PER_PAGE,
  maxPages: number = MAX_SITES_PAGES,
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await fetchPage(page, perPage);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < perPage) break;
  }
  return all;
}

/**
 * Pull a human message out of a Netlify error body. Netlify returns JSON like
 * `{ "code": 404, "message": "Not Found" }` or `{ "error": "..." }`, but some
 * endpoints return plain text — fall back to the raw body / statusText.
 */
export function extractMessage(body: string, fallback: string): string {
  const trimmed = body.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const msg = parsed.message ?? parsed.error ?? parsed.error_description;
      if (typeof msg === 'string' && msg.length > 0) return msg;
    } catch {
      // Not JSON — use the raw text below.
    }
    return trimmed;
  }
  return fallback;
}

/** Build the file-upload URL path: strip the leading slash and escape segments. */
export function uploadPath(deployPath: string): string {
  return deployPath
    .replace(/^\/+/, '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export class NetlifyClient {
  constructor(
    private readonly token: string,
    private readonly signal?: AbortSignal,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    opts: { jsonBody?: unknown; rawBody?: Uint8Array } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    let body: BodyInit | undefined;
    if (opts.jsonBody !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.jsonBody);
    } else if (opts.rawBody !== undefined) {
      headers['Content-Type'] = 'application/octet-stream';
      // TS 5.7's generic `Uint8Array<ArrayBufferLike>` doesn't line up with the
      // DOM `BodyInit` union, but undici/Bun fetch accept a Uint8Array body
      // verbatim — cast at this boundary only.
      body = opts.rawBody as BodyInit;
    }

    // Fail fast on an already-cancelled request so the caller sees [CANCELLED]
    // (not a misleading [NETWORK_ERROR]) — e.g. the deploy poll loop aborting.
    if (this.signal?.aborted) {
      throw new NetlifyApiError('CANCELLED', 'request aborted before it was sent');
    }

    let res: Response;
    try {
      res = await safeFetch(`${NETLIFY_API_BASE}${path}`, { method, headers, body, signal: this.signal });
    } catch (err) {
      // An abort mid-flight surfaces as a DOMException named 'AbortError'.
      // Classify it as CANCELLED, not NETWORK_ERROR, so the agent doesn't
      // retry a request the user/backend deliberately cancelled.
      if (this.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw new NetlifyApiError('CANCELLED', 'request aborted');
      }
      // BlockedUrlError (and any other fetch failure) — already `[CODE]`-prefixed
      // for SSRF blocks; wrap everything else as a network error.
      const msg = err instanceof Error ? err.message : String(err);
      throw new NetlifyApiError('NETWORK_ERROR', msg);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new NetlifyApiError(classify(res.status), extractMessage(text, res.statusText), res.status);
    }

    if (res.status === 204) return undefined as T;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return undefined as T;
    return (await res.json()) as T;
  }

  /** GET /user — validates the token. */
  getUser(): Promise<NetlifyUser> {
    return this.request<NetlifyUser>('GET', '/user');
  }

  /**
   * GET /sites — every site the token can access, across ALL pages.
   *
   * Netlify caps `/sites` at 100 items/page. Fetching only the first page would
   * make `deploy-site`'s "find existing site by name" miss anything on page 2+
   * and create a DUPLICATE site. We page until a short page (`< per_page`) ends
   * the run, bounded by `MAX_SITES_PAGES`.
   */
  listSites(): Promise<NetlifySite[]> {
    return collectPages<NetlifySite>((page, perPage) =>
      this.request<NetlifySite[]>('GET', `/sites?page=${page}&per_page=${perPage}`),
    );
  }

  /** POST /sites — create a site (Netlify auto-names it when `name` is omitted). */
  createSite(name?: string): Promise<NetlifySite> {
    return this.request<NetlifySite>('POST', '/sites', { jsonBody: name ? { name } : {} });
  }

  /** POST /sites/{id}/deploys — declare the file digest, get back `required`. */
  createDeploy(siteId: string, files: Record<string, string>, draft: boolean): Promise<NetlifyDeploy> {
    return this.request<NetlifyDeploy>('POST', `/sites/${encodeURIComponent(siteId)}/deploys`, {
      jsonBody: { files, draft },
    });
  }

  /** PUT /deploys/{id}/files/{path} — upload one file's raw bytes. */
  uploadFile(deployId: string, deployPath: string, bytes: Uint8Array): Promise<NetlifyDeploy> {
    return this.request<NetlifyDeploy>(
      'PUT',
      `/deploys/${encodeURIComponent(deployId)}/files/${uploadPath(deployPath)}`,
      { rawBody: bytes },
    );
  }

  /** GET /deploys/{id} — deploy state for polling. */
  getDeploy(deployId: string): Promise<NetlifyDeploy> {
    return this.request<NetlifyDeploy>('GET', `/deploys/${encodeURIComponent(deployId)}`);
  }

  /** GET /sites/{siteId}/deploys/{deployId} — site-scoped deploy lookup. */
  getSiteDeploy(siteId: string, deployId: string): Promise<NetlifyDeploy> {
    return this.request<NetlifyDeploy>(
      'GET',
      `/sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(deployId)}`,
    );
  }
}
