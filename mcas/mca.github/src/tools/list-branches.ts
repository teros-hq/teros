import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const listBranches: ToolConfig = {
  description: 'List branches in a repository',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      per_page: { type: 'number', description: 'Results per page (default: 30, max: 100)' },
    },
    required: ['owner', 'repo'],
  },
  handler: async (args, context) => {
    const { owner, repo, per_page } = args as { owner: string; repo: string; per_page?: number };
    return await githubRequest(context, `/repos/${owner}/${repo}/branches`, { params: { per_page } });
  },
};
