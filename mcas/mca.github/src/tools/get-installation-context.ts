import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

interface UserInstallation {
  id: number;
  account: { login: string; type: 'User' | 'Organization' } | null;
  repository_selection: 'all' | 'selected';
  permissions?: Record<string, string>;
  app_slug?: string;
}

interface UserInstallationsPayload {
  total_count: number;
  installations: UserInstallation[];
}

interface InstallationReposPayload {
  total_count: number;
  repositories: Array<{
    full_name: string;
    private: boolean;
    owner?: { login: string };
  }>;
}

/**
 * Explicit disclaimer embedded in every `get-installation-context` payload so
 * no consumer mistakes "installations reachable by the user" for "the user".
 */
const INSTALLATIONS_NOTE =
  'Installations reachable by the authenticated user (own account + orgs/collabs) — NOT the user identity. Use get-user for that.';

/**
 * GitHub manage URL for an installation. Personal accounts live under
 * `/settings/installations/<id>`, but org installations only resolve under
 * `/organizations/<login>/settings/installations/<id>` — the personal pattern
 * 404s for orgs (confirmed live: teros-hq installation 130322575).
 */
function manageUrlFor(inst: UserInstallation): string {
  if (inst.account?.type === 'Organization' && inst.account.login) {
    return `https://github.com/organizations/${inst.account.login}/settings/installations/${inst.id}`;
  }
  return `https://github.com/settings/installations/${inst.id}`;
}

/**
 * v5.0.0+ — under userOAuth, list every installation of the Teros App
 * reachable by the current user (their personal account + any orgs they
 * belong to where the App is installed). Each entry includes the granted
 * permissions, repository selection mode, accessible repos, and the
 * GitHub manage URL.
 *
 * ⚠️ This is NOT the user's identity. The `account` field of each entry is
 * the account that OWNS the installation (can be an org or another user the
 * authenticated user collaborates with) — reading it as "your account"
 * produces false identity reports. Use `get-user` (GET /user) for the real
 * token identity.
 *
 * Replaces the v4 single-installation view (which used the server-to-server
 * `/installation/repositories` endpoint).
 */
export const getInstallationContext: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List the Teros GitHub App installations reachable by the authenticated user (own account + orgs/collabs) — NOT the user identity; use get-user for that. Includes accessible repos, granted permissions, and manage/install URLs.',
  parameters: { type: 'object', properties: {} },
  handler: async (_args, context) => {
    const sys = await context.getSystemSecrets();
    const slug = sys.GITHUB_APP_SLUG ?? 'teros';
    const installUrl = `https://github.com/apps/${slug}/installations/new`;

    const installationsPayload = (await githubRequest(context, '/user/installations', {
      params: { per_page: 100 },
    })) as UserInstallationsPayload;

    const installations = installationsPayload.installations ?? [];
    if (installations.length === 0) {
      return {
        app: { name: 'Teros', slug },
        note: INSTALLATIONS_NOTE,
        installations: [],
        install_url: installUrl,
      };
    }

    const enriched = await Promise.all(
      installations.map(async (inst) => {
        const repos = (await githubRequest(
          context,
          `/user/installations/${inst.id}/repositories`,
          { params: { per_page: 100 } },
        )) as InstallationReposPayload;
        return {
          id: inst.id,
          account: inst.account?.login ?? null,
          account_type: inst.account?.type ?? null,
          repository_selection: inst.repository_selection,
          permissions: inst.permissions ?? {},
          repository_count: repos.total_count,
          repositories: repos.repositories.map((r) => ({
            full_name: r.full_name,
            private: r.private,
          })),
          manage_url: manageUrlFor(inst),
        };
      }),
    );

    return {
      app: { name: 'Teros', slug },
      note: INSTALLATIONS_NOTE,
      installations: enriched,
      install_url: installUrl,
    };
  },
};
