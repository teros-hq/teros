import type { ToolContext } from '@teros/mca-sdk';
import { resolveInstallationToken } from './github-app-token';
import { resolveUserToken } from './github-user-token';

const BASE_URL = 'https://api.github.com';

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

export interface GitHubErrorBody {
  message?: string;
  documentation_url?: string;
  errors?: Array<{ resource?: string; field?: string; code?: string; message?: string }>;
}

/**
 * Resolve the auth token for an outgoing request.
 *
 * v5.0.0+ uses **user-to-server tokens**: each user authorizes the App at
 * install time and obtains their own `user_access_token`. Acciones aparecen
 * firmadas con la identidad humana del user (commits, PRs, comments).
 *
 * Fallback to installation token: only when `USER_ACCESS_TOKEN` is missing
 * AND `INSTALLATION_ID` is present (legacy users post-deploy that no han
 * reconectado todavía). En ese caso lanzamos `GitHubUserNotAuthenticatedError`
 * para forzar reconexión — la migración exige re-auth.
 */
async function resolveToken(context: ToolContext): Promise<string> {
  const user = await context.getUserSecrets();
  if (user.USER_ACCESS_TOKEN) {
    return resolveUserToken(context);
  }
  // No user token available: surface a clear error so the user reconnects.
  return resolveUserToken(context);
}

/**
 * Internal: resolve installation token (server-to-server). Reserved for
 * autorun / webhook flows that don't have a user context. Not used by tools
 * by default — see `resolveToken`.
 */
export async function resolveServerSideToken(context: ToolContext): Promise<string> {
  return resolveInstallationToken(context);
}

export async function githubRequest(
  context: ToolContext,
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    params?: Record<string, string | number | boolean | undefined>;
    accept?: string;
  } = {},
): Promise<unknown> {
  const token = await resolveToken(context);
  const { method = 'GET', body, params, accept } = options;

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

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept ?? 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'Teros-MCA-GitHub',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
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
    throw new GitHubApiError({
      status: response.status,
      statusText: response.statusText,
      body: parsed,
      documentationUrl: docUrl,
      rateLimitRemaining: remaining ? Number.parseInt(remaining, 10) : null,
      rateLimitReset: reset ? Number.parseInt(reset, 10) : null,
    });
  }

  if (response.status === 204) return { success: true };
  if (accept && accept !== 'application/vnd.github+json' && !accept.includes('json')) {
    return response.text();
  }
  return response.json();
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
