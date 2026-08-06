import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

interface InstallationReposPayload {
  total_count: number;
  repositories: Array<Record<string, unknown>>;
}

/**
 * Whitelist of fields the agent + frontend renderer actually use. Prevents
 * the raw GitHub repo object (~3KB each, mostly URLs) from blowing past
 * `MAX_TOOL_OUTPUT_CHARS=40000` on accounts with >12 repos and getting
 * silently truncated to an unparseable JSON.
 */
function curateRepo(r: Record<string, unknown>): Record<string, unknown> {
  const owner = r.owner as { login?: string; avatar_url?: string } | undefined;
  return {
    id: r.id,
    name: r.name,
    full_name: r.full_name,
    private: r.private,
    visibility: r.visibility,
    description: r.description,
    default_branch: r.default_branch,
    language: r.language,
    stargazers_count: r.stargazers_count,
    forks_count: r.forks_count,
    open_issues_count: r.open_issues_count,
    archived: r.archived,
    fork: r.fork,
    pushed_at: r.pushed_at,
    updated_at: r.updated_at,
    html_url: r.html_url,
    owner: owner ? { login: owner.login, avatar_url: owner.avatar_url } : undefined,
  };
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
 * `owner` filter is applied client-side. `per_page`/`page` apply per
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

    const installationsPayload = (await githubRequest(context, '/user/installations', {
      params: { per_page: 100 },
    })) as { installations?: Array<{ id: number }> };

    const installations = installationsPayload.installations ?? [];
    if (installations.length === 0) {
      return { total_count: 0, repositories: [] };
    }

    const aggregated: Array<Record<string, unknown>> = [];
    for (const inst of installations) {
      const reposPayload = (await githubRequest(
        context,
        `/user/installations/${inst.id}/repositories`,
        { params: { per_page, page } },
      )) as InstallationReposPayload;
      if (Array.isArray(reposPayload.repositories)) {
        aggregated.push(...reposPayload.repositories);
      }
    }

    const filtered = owner
      ? aggregated.filter((r) => {
          const ownerLogin =
            (r.owner as { login?: string } | undefined)?.login?.toLowerCase() ??
            (typeof r.full_name === 'string' ? r.full_name.split('/')[0].toLowerCase() : '');
          return ownerLogin === owner.toLowerCase();
        })
      : aggregated;

    return {
      total_count: filtered.length,
      repositories: filtered.map(curateRepo),
    };
  },
};
