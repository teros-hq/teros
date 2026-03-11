import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const listPulls: ToolConfig = {
  description: 'List pull requests for a repository',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state (default: open)' },
      sort: { type: 'string', enum: ['created', 'updated', 'popularity', 'long-running'], description: 'Sort by (default: created)' },
      per_page: { type: 'number', description: 'Results per page (default: 30, max: 100)' },
    },
    required: ['owner', 'repo'],
  },
  handler: async (args, context) => {
    const { owner, repo, state, sort, per_page } = args as {
      owner: string; repo: string; state?: string; sort?: string; per_page?: number;
    };
    return await githubRequest(context, `/repos/${owner}/${repo}/pulls`, { params: { state, sort, per_page } });
  },
};
