import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const listReleases: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List releases of a repository, newest first. Each release includes {id, tag_name, name, draft, prerelease, body, html_url, published_at, author}.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      per_page: { type: 'number', description: 'Results per page (default: 30, max: 100)' },
      page: { type: 'number', description: 'Page index (1-based)' },
    },
    required: ['owner', 'repo'],
  },
  handler: async (args, context) => {
    const { owner, repo, per_page, page } = args as {
      owner: string;
      repo: string;
      per_page?: number;
      page?: number;
    };
    return await githubRequest(context, `/repos/${owner}/${repo}/releases`, {
      params: { per_page, page },
    });
  },
};
