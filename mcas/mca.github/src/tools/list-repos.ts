import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';
import { curateRepo } from '../lib/curate';
import { appInstallUrl } from './_github-error';

interface InstallationReposPayload {
  total_count: number;
  repositories: Array<Record<string, unknown>>;
}

/**
 * v5.0.0+ — under userOAuth, list repos accessible to the user across every
 * installation of the Teros App they can reach (their personal account +
 * any orgs where they're a member with the App installed). We:
 *
 *   1. `GET /user/installations` — list installations visible to the user.
 *   2. For each, `GET /user/installations/{id}/repositories` — repos the
 *      user can access through that installation.
 *
 * Both endpoints accept the user_access_token. The v4 endpoint
 * `/installation/repositories` requires a server-to-server installation
 * token and rejects user tokens with "Resource not accessible by integration".
 *
 * `owner` picks the matching installations first. `per_page`/`page` apply per
 * installation request.
 */
export const listRepos: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List repositories accessible to the current user via the Teros GitHub App (across every installation reachable). Pass `owner` to filter to a specific user/org.',
  parameters: {
    type: 'object',
    properties: {
      owner: {
        type: 'string',
        description: 'Optional filter — only return repos under this user or organization.',
      },
      per_page: {
        type: 'number',
        description: 'Results per page (default: 30, max: 100).',
      },
      page: {
        type: 'number',
        description: 'Page index (1-based).',
      },
    },
  },
  handler: async (args, context) => {
    const { owner, per_page, page } = args as {
      owner?: string;
      per_page?: number;
      page?: number;
    };
    const pageNo = page && page > 0 ? Math.floor(page) : 1;
    const perPage = per_page && per_page > 0 ? Math.min(Math.floor(per_page), 100) : 30;

    const installationsPayload = (await githubRequest(context, '/user/installations', {
      params: { per_page: 100 },
    })) as { installations?: Array<{ id: number; account?: { login?: string } }> };

    const all = installationsPayload.installations ?? [];
    if (all.length === 0) {
      const sys = await context.getSystemSecrets().catch(() => ({}) as Record<string, string>);
      return {
        total_count: 0,
        repositories: [],
        note: `The Teros GitHub App is not installed on any account or organization this user can reach, so no repository is available. Ask the user to install it: ${appInstallUrl(sys.GITHUB_APP_SLUG)}`,
      };
    }
    const installations = owner
      ? all.filter((i) => i.account?.login?.toLowerCase() === owner.toLowerCase())
      : all;
    if (installations.length === 0) {
      return {
        total_count: 0,
        repositories: [],
        note: `The Teros GitHub App is installed on ${all.map((i) => i.account?.login).filter(Boolean).join(', ')}, but not on ${owner}. Ask an owner of ${owner} to install it there.`,
      };
    }

    const repositories: Array<Record<string, unknown>> = [];
    let total = 0;
    let largest = 0;
    for (const inst of installations) {
      const reposPayload = (await githubRequest(context, `/user/installations/${inst.id}/repositories`, {
        params: { per_page: perPage, page: pageNo },
      })) as InstallationReposPayload;
      if (Array.isArray(reposPayload.repositories)) repositories.push(...reposPayload.repositories);
      const count = typeof reposPayload.total_count === 'number' ? reposPayload.total_count : 0;
      total += count;
      largest = Math.max(largest, count);
    }

    return {
      total_count: total,
      page: pageNo,
      per_page: perPage,
      has_next_page: pageNo * perPage < largest,
      repositories: repositories.map(curateRepo),
    };
  },
};
