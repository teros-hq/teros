import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const listRepos: ToolConfig = {
  description: 'List repositories for a user or organization. Supports filtering and sorting.',
  parameters: {
    type: 'object',
    properties: {
      owner: {
        type: 'string',
        description: 'GitHub username or organization. Defaults to authenticated user.',
      },
      type: {
        type: 'string',
        enum: ['all', 'owner', 'member', 'public', 'private'],
        description: 'Filter by repository type (default: all)',
      },
      sort: {
        type: 'string',
        enum: ['created', 'updated', 'pushed', 'full_name'],
        description: 'Sort repositories by (default: updated)',
      },
      per_page: {
        type: 'number',
        description: 'Results per page (default: 30, max: 100)',
      },
    },
  },
  handler: async (args, context) => {
    const { owner, type, sort, per_page } = args as {
      owner?: string;
      type?: string;
      sort?: string;
      per_page?: number;
    };

    const params = { type, sort, per_page };

    if (owner) {
      return await githubRequest(context, `/users/${owner}/repos`, { params });
    }
    return await githubRequest(context, '/user/repos', { params });
  },
};
