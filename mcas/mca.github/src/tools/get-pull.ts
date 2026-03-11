import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const getPull: ToolConfig = {
  description: 'Get details of a specific pull request',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      pull_number: { type: 'number', description: 'Pull request number' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
  handler: async (args, context) => {
    const { owner, repo, pull_number } = args as { owner: string; repo: string; pull_number: number };
    return await githubRequest(context, `/repos/${owner}/${repo}/pulls/${pull_number}`);
  },
};
