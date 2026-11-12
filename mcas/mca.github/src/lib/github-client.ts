import type { ToolContext } from '@teros/mca-sdk';
import { resolveUserToken } from './github-user-token';

const BASE_URL = 'https://api.github.com';

/**
 * Default per-attempt timeout for `githubRequest`. Overridable per call via
 * `options.timeoutMs` for slow endpoints (e.g. list-workflow-runs on large
 * repos). Matches the protection the local git paths already have
 * (git-local 60s, clone 120s) — see audit task_680abdc17728eb55.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Maximum retries after the first attempt (429/5xx only — see policy below). */
const MAX_RETRIES = 2;

/**
 * Retry/timeout pacing knobs for `githubRequest`.
 *
 * Mutable on purpose: tests shrink the delays to keep the suite fast, and
 * deployments may tune them. Defaults: exponential backoff 500ms → 1s → 2s
 * with ±25% jitter, server-advertised Retry-After honored up to 5s.
 */
export const githubRequestPacing = {
  /** Base delay for exponential backoff: base × 2^attempt (500ms → 1s → 2s). */
  baseDelayMs: 500,
  /**
   * Cap on server-advertised Retry-After waits. A long advisory (e.g. 60s for
   * secondary rate limits) would stall the agent's turn — better to fail
   * fast and let the caller decide than to sleep through it.
   */
  maxRetryAfterMs: 5_000,
  /** Jitter fraction (±25%) applied to computed backoff delays. */
  jitter: 0.25,
};

export class GitHubApiError extends Error {
  readonly status: number;
  readonly body: GitHubErrorBody | string | null;
  readonly documentationUrl: string | null;
  readonly rateLimitRemaining: number | null;
  readonly rateLimitReset: number | null;

  constructor(opts: {
    status: number;
    statusText: string;
    body: GitHubErrorBody | string | null;
    documentationUrl: string | null;
    rateLimitRemaining: number | null;
    rateLimitReset: number | null;
  }) {
    const literal =
      (typeof opts.body === 'object' && opts.body && opts.body.message) ||
      (typeof opts.body === 'string' && opts.body) ||
      opts.statusText ||
      `HTTP ${opts.status}`;
    super(literal);
    this.name = 'GitHubApiError';
    this.status = opts.status;
    this.body = opts.body;
    this.documentationUrl = opts.documentationUrl;
    this.rateLimitRemaining = opts.rateLimitRemaining;
    this.rateLimitReset = opts.rateLimitReset;
  }
}

/**
 * A `githubRequest` attempt exceeded its timeout (`options.timeoutMs`,
 * default 30s) and was aborted. Extends `GitHubApiError` with status 0 so
 * existing error handling keeps working; `timedOut` distinguishes it from
 * upstream HTTP errors.
 */
export class GitHubTimeoutError extends GitHubApiError {
  readonly timedOut = true as const;
  readonly timeoutMs: number;

  constructor(timeoutMs: number, url: string) {
    super({
      status: 0,
      statusText: 'Request timed out',
      body: `GitHub API timeout after ${timeoutMs}ms: ${url}`,
      documentationUrl: null,
      rateLimitRemaining: null,
      rateLimitReset: null,
    });
    this.name = 'GitHubTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Agent-supplied input failed boundary validation before any request was
 * made — bad owner/repo/org/workflow_id charset, path traversal in an API
 * path, etc. Extends `GitHubApiError` with status 400 so existing error
 * handling keeps working; the `[GITHUB_INVALID_INPUT]` tag distinguishes a
 * local rejection from an upstream 400 — this error never reached GitHub.
 * (Audit task_a8f981f535d6b3c3, parity with clone-repo's OWNER_REPO_RE.)
 */
export class GitHubInvalidInputError extends GitHubApiError {
  constructor(message: string) {
    super({
      status: 400,
      statusText: 'Invalid input',
      body: { message: `[GITHUB_INVALID_INPUT] ${message}` },
      documentationUrl: null,
      rateLimitRemaining: null,
      rateLimitReset: null,
    });
    this.name = 'GitHubInvalidInputError';
  }
}

export interface GitHubErrorBody {
  message?: string;
  documentation_url?: string;
  errors?: Array<{ resource?: string; field?: string; code?: string; message?: string }>;
}

// =============================================================================
// Boundary validation — audit task_a8f981f535d6b3c3 (parity with clone-repo)
// =============================================================================
// Every agent-supplied identifier interpolated into an API path (owner, repo,
// org, workflow_id…) must be a single GitHub-safe segment, and the assembled
// path must not be able to redirect the request (no `.`/`..` segments, no
// `//`, no query/fragment markers — query values belong in `options.params`).

/**
 * Charset for a single GitHub path segment (owner/repo/org login, workflow id
 * or filename). Same source as clone-repo's historic `OWNER_REPO_RE`, moved
 * here so the REST tools and the clone path validate identically.
 */
export const GITHUB_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Validate an agent-supplied identifier that a tool interpolates into an API
 * path. `undefined`/`null` pass (optional parameter not provided → nothing is
 * interpolated); any other value that is not a single GitHub-safe segment
 * throws `GitHubInvalidInputError` with the offending field named.
 */
export function assertGitHubSegment(value: string | undefined | null, field: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || !GITHUB_SEGMENT_RE.test(value)) {
    throw new GitHubInvalidInputError(
      `Invalid ${field} ${JSON.stringify(String(value))}: must match ${GITHUB_SEGMENT_RE.source} (single GitHub path segment — no slashes, whitespace, or URL/shell metacharacters).`,
    );
  }
}

/**
 * Validate the owner/repo pair every REST tool interpolates into
 * `/repos/{owner}/{repo}/...` — a one-liner per tool with per-field errors.
 */
export function assertOwnerRepo(owner: string | undefined, repo: string | undefined): void {
  assertGitHubSegment(owner, 'owner');
  assertGitHubSegment(repo, 'repo');
}

/** Characters that never appear in a legitimate `githubRequest` path. */
const FORBIDDEN_PATH_CHARS_RE = /[\s\\?#]|[\x00-\x1f\x7f-\x9f]/;

/**
 * Central defense on the full request path — `githubRequest` applies this
 * before resolving any token. Catches whatever the per-field asserts cannot
 * express (branch/ref names may contain `/`, numeric ids, pre-encoded file
 * paths…): rejects `.`/`..` segments (traversal to another API endpoint),
 * empty segments (`//`), backslashes, `?`/`#` (query/fragment injection —
 * query values belong in `options.params`), whitespace and control
 * characters. No interpolated value can redirect the request or poison the
 * URL once this passes.
 */
export function assertGitHubApiPath(path: string): void {
  if (typeof path !== 'string' || path === '') {
    throw new GitHubInvalidInputError('`path` must be a non-empty string.');
  }
  if (FORBIDDEN_PATH_CHARS_RE.test(path)) {
    throw new GitHubInvalidInputError(
      `\`path\` contains characters that are never valid in an API path (whitespace, control characters, "\\", "?" or "#"): ${JSON.stringify(path)}`,
    );
  }
  // `.`/`..` traversal segments are checked on the RAW string: the URL parser
  // would silently resolve them away (`new URL('.../repos/../user').pathname`
  // is `/user`), hiding the redirect from a pathname-only check.
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new GitHubInvalidInputError(
      `\`path\` must not contain "." or ".." segments (path traversal): ${JSON.stringify(path)}`,
    );
  }
  if (/^https?:\/\//i.test(path)) {
    // Absolute-URL form (rare — no current tool uses it): must parse, and the
    // resolved pathname must still be a clean rooted path.
    let pathname: string;
    try {
      pathname = new URL(path).pathname;
    } catch {
      throw new GitHubInvalidInputError(`\`path\` is not a valid URL: ${JSON.stringify(path)}`);
    }
    if (!pathname.startsWith('/') || pathname.includes('//')) {
      throw new GitHubInvalidInputError(
        `\`path\` must resolve to a clean rooted pathname: ${JSON.stringify(path)}`,
      );
    }
    return;
  }
  if (!path.startsWith('/')) {
    throw new GitHubInvalidInputError(`\`path\` must start with "/": ${JSON.stringify(path)}`);
  }
  if (path.includes('//')) {
    throw new GitHubInvalidInputError(
      `\`path\` must not contain empty segments ("//"): ${JSON.stringify(path)}`,
    );
  }
}

export async function githubRequest(
  context: ToolContext,
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    params?: Record<string, string | number | boolean | undefined>;
    accept?: string;
    /** Per-attempt timeout in ms (default 30s). Raise for slow endpoints
     * such as list-workflow-runs on large repos. */
    timeoutMs?: number;
    onResponse?: (response: Response) => void;
  } = {},
): Promise<unknown> {
  // Boundary validation (audit task_a8f981f535d6b3c3): reject unsafe paths
  // before resolving any token or touching the network.
  assertGitHubApiPath(path);

  // v5 is user-to-server only: every request acts with the user's own GitHub
  // identity. `resolveUserToken` throws `GitHubUserNotAuthenticatedError`
  // (with the reconnect URL) if no token is available — there is no fallback
  // to an installation token here.
  const token = await resolveUserToken(context);
  const { method = 'GET', body, params, accept, timeoutMs = DEFAULT_TIMEOUT_MS, onResponse } = options;

  let url = path.startsWith('http') ? path : `${BASE_URL}${path}`;

  if (params) {
    // We avoid `URLSearchParams.toString()` because it %2F-encodes forward
    // slashes inside values. GitHub returns 404 for several endpoints when
    // the `ref` query parameter (or other branch identifiers) is sent with
    // %2F instead of literal `/` — for instance, `?ref=claude/branch-name`.
    // We URL-encode each value for safety against `&`, `?`, spaces… but
    // restore `/` to its raw form, which GitHub accepts.
    const parts: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      const encoded = encodeURIComponent(String(value)).replace(/%2F/g, '/');
      parts.push(`${encodeURIComponent(key)}=${encoded}`);
    }
    if (parts.length > 0) url += `?${parts.join('&')}`;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: accept ?? 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'Teros-MCA-GitHub',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const serializedBody = body ? JSON.stringify(body) : undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Transport-level failures (timeout abort, network error) throw here and
    // are NOT retried: a hanging connection usually stays hanging, and a
    // network error on a mutation may have already been applied server-side.
    const response = await fetchWithTimeout(
      url,
      { method, headers, body: serializedBody },
      timeoutMs,
    );

    if (response.ok) {
      onResponse?.(response);
      if (response.status === 204) return { success: true };
      if (accept && accept !== 'application/vnd.github+json' && !accept.includes('json')) {
        return response.text();
      }
      return response.json();
    }

    // Non-2xx: retry transient failures (see isRetryableResponse), then
    // surface the upstream error with rate-limit context intact.
    if (attempt < MAX_RETRIES && isRetryableResponse(response, method)) {
      await sleep(computeRetryDelayMs(attempt, response));
      continue;
    }

    throw await buildApiError(response);
  }

  // Unreachable: the last loop iteration always returns or throws.
  throw new Error('GitHub API request failed unexpectedly');
}

/**
 * fetch with a per-attempt AbortController. A stalled connection (TCP stall,
 * black-holed request) is aborted at `timeoutMs` and surfaced as
 * `GitHubTimeoutError` instead of hanging the tool call indefinitely.
 */
async function fetchWithTimeout(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (isAbortError(error)) {
      throw new GitHubTimeoutError(timeoutMs, url);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Duck-typed AbortError check (DOMException or Error, by name). */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * Retry policy (audit task_680abdc17728eb55):
 * - 429: the request was rejected before any side effect — safe to retry
 *   for every method.
 * - 503 + Retry-After: GitHub explicitly says "try again in N seconds"
 *   (maintenance / load shedding) — safe to retry for every method.
 * - 500/502/503/504 without Retry-After: transient LB/app-server failures —
 *   GET only; a mutation may have been applied server-side before the
 *   failure, so we stay conservative.
 * - Any other 4xx/5xx: never retried.
 */
function isRetryableResponse(response: Response, method: string): boolean {
  if (response.status === 429) return true;
  if (response.status === 503 && response.headers.get('retry-after') !== null) return true;
  if (
    response.status === 500 ||
    response.status === 502 ||
    response.status === 503 ||
    response.status === 504
  ) {
    return method === 'GET';
  }
  return false;
}

/**
 * Delay before the next attempt: the server-advertised Retry-After when
 * present (capped — see githubRequestPacing.maxRetryAfterMs), otherwise
 * exponential backoff with jitter.
 */
function computeRetryDelayMs(attempt: number, response: Response): number {
  const advertised = parseRetryAfterMs(response.headers.get('retry-after'));
  if (advertised !== null) return advertised;

  const backoff = githubRequestPacing.baseDelayMs * 2 ** attempt;
  const jitter = 1 + (Math.random() - 0.5) * 2 * githubRequestPacing.jitter;
  return Math.round(backoff * jitter);
}

/** Parse a Retry-After header (delay-seconds or HTTP-date), capped. */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds >= 0 && String(seconds) === header.trim()) {
    return Math.min(seconds * 1000, githubRequestPacing.maxRetryAfterMs);
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(date - Date.now(), 0), githubRequestPacing.maxRetryAfterMs);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build the GitHubApiError for a non-2xx response (rate-limit info intact). */
async function buildApiError(response: Response): Promise<GitHubApiError> {
  const rawText = await response.text().catch(() => '');
  let parsed: GitHubErrorBody | string | null = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText) as GitHubErrorBody;
    } catch {
      parsed = rawText;
    }
  }
  const docUrl =
    typeof parsed === 'object' && parsed?.documentation_url ? parsed.documentation_url : null;
  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = response.headers.get('x-ratelimit-reset');
  return new GitHubApiError({
    status: response.status,
    statusText: response.statusText,
    body: parsed,
    documentationUrl: docUrl,
    rateLimitRemaining: remaining ? Number.parseInt(remaining, 10) : null,
    rateLimitReset: reset ? Number.parseInt(reset, 10) : null,
  });
}

/**
 * Make an UNAUTHENTICATED request (used by the `app` JWT auth flow itself,
 * before any installation token exists). Currently unused — kept as a hook
 * for future Apps-as-bots tooling.
 */
export async function githubAppJwtRequest(
  jwt: string,
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<unknown> {
  assertGitHubApiPath(path);
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'Teros-MCA-GitHub',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`GitHub App JWT request ${response.status}: ${text}`);
  }
  return response.json();
}
