/**
 * GitHub App installation token resolver.
 *
 * Reads the App's private key + ID from `systemSecrets` and the user's
 * `INSTALLATION_ID` from `userSecrets`, then signs a short-lived JWT and
 * exchanges it for a 1h installation access token via
 * `POST /app/installations/{id}/access_tokens`.
 *
 * The result is cached in-memory for `expires_at - 60s` to avoid hitting
 * the JWT/token-exchange path on every tool call. Cache key includes the
 * permission set so that scoped-down tokens don't collide with full-scope
 * ones.
 *
 * Per-process cache is intentional: each `mca.github` container is
 * `containerMode: per-app` so the in-memory map is naturally scoped to the
 * single user it serves.
 */

import { createAppAuth } from '@octokit/auth-app';
import type { ToolContext } from '@teros/mca-sdk';

const SAFETY_BUFFER_MS = 60_000;

interface CachedToken {
  token: string;
  expiresAt: number; // ms epoch
  permissions: Record<string, string>;
}

const cache = new Map<string, CachedToken>();

export class GitHubAppNotInstalledError extends Error {
  readonly code = 'APP_NOT_INSTALLED' as const;
  readonly installUrl: string;

  constructor(installUrl: string) {
    super(
      `Teros App is not installed on this account. Install it at ${installUrl} to continue.`,
    );
    this.name = 'GitHubAppNotInstalledError';
    this.installUrl = installUrl;
  }
}

interface AppCredentials {
  appId: string;
  privateKey: string;
  clientId?: string;
  appSlug: string;
}

function readAppCredentials(systemSecrets: Record<string, string>): AppCredentials {
  const appId = systemSecrets.GITHUB_APP_ID;
  const privateKey = systemSecrets.GITHUB_APP_PRIVATE_KEY;
  const clientId = systemSecrets.GITHUB_APP_CLIENT_ID;
  const appSlug = systemSecrets.GITHUB_APP_SLUG ?? 'teros';
  if (!appId || !privateKey) {
    throw new Error(
      'GitHub App credentials missing: GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required in system secrets.',
    );
  }
  return { appId, privateKey, clientId, appSlug };
}

function cacheKey(installationId: string, permissions?: Record<string, string>): string {
  if (!permissions || Object.keys(permissions).length === 0) {
    return `${installationId}:default`;
  }
  const sorted = Object.keys(permissions)
    .sort()
    .map((k) => `${k}=${permissions[k]}`)
    .join(',');
  return `${installationId}:${sorted}`;
}

/**
 * Get a fresh installation access token, using cache when possible.
 *
 * @param context — MCA tool context (must expose `getSystemSecrets` + `getUserSecrets`).
 * @param permissions — optional scoped permissions; omit for full installation permissions.
 */
export async function resolveInstallationToken(
  context: ToolContext,
  permissions?: Record<string, string>,
): Promise<string> {
  const sys = await context.getSystemSecrets();
  const user = await context.getUserSecrets();

  const installationId = user.INSTALLATION_ID;
  if (!installationId) {
    const slug = sys.GITHUB_APP_SLUG ?? 'teros';
    throw new GitHubAppNotInstalledError(
      `https://github.com/apps/${slug}/installations/new`,
    );
  }

  const key = cacheKey(installationId, permissions);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt - SAFETY_BUFFER_MS > now) {
    return cached.token;
  }

  // Test escape hatch: avoid heavy RSA signing during unit tests. Production
  // never sets this env var (it is whitelisted to test runners).
  if (process.env.MCA_GITHUB_TEST_TOKEN) {
    cache.set(key, {
      token: process.env.MCA_GITHUB_TEST_TOKEN,
      expiresAt: now + 60 * 60 * 1000,
      permissions: {},
    });
    return process.env.MCA_GITHUB_TEST_TOKEN;
  }

  const creds = readAppCredentials(sys);
  const auth = createAppAuth({
    appId: creds.appId,
    privateKey: creds.privateKey,
    clientId: creds.clientId,
  });

  const result = (await auth({
    type: 'installation',
    installationId,
    permissions,
  })) as { token: string; expiresAt: string; permissions?: Record<string, string> };

  const expiresAtMs = Date.parse(result.expiresAt);
  cache.set(key, {
    token: result.token,
    expiresAt: Number.isFinite(expiresAtMs) ? expiresAtMs : now + 60 * 60 * 1000,
    permissions: result.permissions ?? {},
  });

  return result.token;
}

/**
 * Read the install URL for this MCA — used by error messages and the
 * permission widget.
 */
export async function getInstallUrl(context: ToolContext): Promise<string> {
  const sys = await context.getSystemSecrets();
  const slug = sys.GITHUB_APP_SLUG ?? 'teros';
  return `https://github.com/apps/${slug}/installations/new`;
}

/**
 * Test-only: clear the cache so unit tests don't bleed state.
 */
export function __resetCacheForTests(): void {
  cache.clear();
}
