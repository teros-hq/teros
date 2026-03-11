import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const listIssues: ToolConfig = {
  description: 'List issues for a repository with optional filters',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state (default: open)' },
      labels: { type: 'string', description: 'Comma-separated list of label names' },
      sort: { type: 'string', enum: ['created', 'updated', 'comments'], description: 'Sort by (default: created)' },
      per_page: { type: 'number', description: 'Results per page (default: 30, max: 100)' },
    },
    required: ['owner', 'repo'],
  },
  handler: async (args, context) => {
    const { owner, repo, state, labels, sort, per_page } = args as {
      owner: string; repo: string; state?: string; labels?: string; sort?: string; per_page?: number;
    };
    return await githubRequest(context, `/repos/${owner}/${repo}/issues`, { params: { state, labels, sort, per_page } });
  },
};
