import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const searchRepos: ToolConfig = {
  description: 'Search for repositories on GitHub',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (e.g., "react language:javascript stars:>1000")' },
      sort: { type: 'string', enum: ['stars', 'forks', 'help-wanted-issues', 'updated'], description: 'Sort results by' },
      per_page: { type: 'number', description: 'Results per page (default: 30, max: 100)' },
    },
    required: ['query'],
  },
  handler: async (args, context) => {
    const { query, sort, per_page } = args as { query: string; sort?: string; per_page?: number };
    return await githubRequest(context, '/search/repositories', { params: { q: query, sort, per_page } });
  },
};
