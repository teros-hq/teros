import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const getBranch: ToolConfig = {
  description: 'Get information about a specific branch',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      branch: { type: 'string', description: 'Branch name' },
    },
    required: ['owner', 'repo', 'branch'],
  },
  handler: async (args, context) => {
    const { owner, repo, branch } = args as { owner: string; repo: string; branch: string };
    return await githubRequest(context, `/repos/${owner}/${repo}/branches/${branch}`);
  },
};
