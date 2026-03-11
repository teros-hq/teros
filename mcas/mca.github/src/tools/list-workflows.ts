import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const listWorkflows: ToolConfig = {
  description: 'List workflows in a repository',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
    },
    required: ['owner', 'repo'],
  },
  handler: async (args, context) => {
    const { owner, repo } = args as { owner: string; repo: string };
    return await githubRequest(context, `/repos/${owner}/${repo}/actions/workflows`);
  },
};
