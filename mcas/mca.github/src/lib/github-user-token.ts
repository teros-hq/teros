/**
 * GitHub user-to-server token resolver.
 *
 * Each user obtains their own `user_access_token` via OAuth at install time
 * (when the GitHub App has "Request user authorization (OAuth) during
 * installation" enabled). The backend `mca-oauth.ts` persists it as
 * `USER_ACCESS_TOKEN` in user secrets along with `USER_REFRESH_TOKEN`,
 * `USER_TOKEN_EXPIRES_AT` and `USER_LOGIN`.
 *
 * Token lifetime: 8h access + 6 months refresh. Refresh is performed by the
 * backend (see `McaOAuth.refreshToken`) preventively when `getAuthStatus`
 * runs (5 min buffer); per-tool-call refresh is therefore rare. If the
 * token is missing entirely, the user must reconnect.
 *
 * v5 is user-to-server only: there is no server-side installation-token
 * resolver anymore (dead since v5 — task_16d9e3d1ee40658d). The error class
 * below is kept because the error classifier maps upstream 403s
 * ("installation suspended / not authorized") to APP_NOT_INSTALLED.
 */

import type { ToolContext } from '@teros/mca-sdk';

export class GitHubUserNotAuthenticatedError extends Error {
  readonly code = 'USER_NOT_AUTHENTICATED' as const;
  readonly installUrl: string;

  constructor(installUrl: string) {
    super('GitHub is not connected for this user in Teros.');
    this.name = 'GitHubUserNotAuthenticatedError';
    this.installUrl = installUrl;
  }
}

/**
 * The Teros App is not installed (or its installation was suspended/removed)
 * on the account. Surfaced by upstream 403 mapping — see
 * `classifyGitHubError` in `src/tools/_github-error.ts`.
 */
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

/**
 * Resolve the user access token for an outgoing request.
 * Throws `GitHubUserNotAuthenticatedError` if no token is available — the
 * caller should surface this so the user can reconnect.
 */
export async function resolveUserToken(context: ToolContext): Promise<string> {
  const user = await context.getUserSecrets();
  const token = user.USER_ACCESS_TOKEN;
  if (token) return token;

  const sys = await context.getSystemSecrets();
  const slug = sys.GITHUB_APP_SLUG ?? 'teros';
  throw new GitHubUserNotAuthenticatedError(
    `https://github.com/apps/${slug}/installations/new`,
  );
}

/**
 * Read the install URL — used by error messages and the permission widget.
 */
export async function getInstallUrl(context: ToolContext): Promise<string> {
  const sys = await context.getSystemSecrets();
  const slug = sys.GITHUB_APP_SLUG ?? 'teros';
  return `https://github.com/apps/${slug}/installations/new`;
}
