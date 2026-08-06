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
 * v5.0.0+ — under userOAuth, list every installation of the Teros App
 * reachable by the current user (their personal account + any orgs they
 * belong to where the App is installed). Each entry includes the granted
 * permissions, repository selection mode, accessible repos, and the
 * GitHub manage URL.
 *
 * Replaces the v4 single-installation view (which used the server-to-server
 * `/installation/repositories` endpoint).
 */
export const getInstallationContext: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List the Teros GitHub App installations reachable by the current user, with accessible repos, granted permissions, and manage/install URLs.',
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
          manage_url: `https://github.com/settings/installations/${inst.id}`,
        };
      }),
    );

    return {
      app: { name: 'Teros', slug },
      installations: enriched,
      install_url: installUrl,
    };
  },
};

/**
 * Deprecated alias kept for one major version. Returns the same shape as
 * `get-installation-context` so legacy callers don't break.
 */
export const getUser = getInstallationContext;
