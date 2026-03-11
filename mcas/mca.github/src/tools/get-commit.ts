import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const getCommit: ToolConfig = {
  description: 'Get details of a specific commit',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      ref: { type: 'string', description: 'Commit SHA' },
    },
    required: ['owner', 'repo', 'ref'],
  },
  handler: async (args, context) => {
    const { owner, repo, ref } = args as { owner: string; repo: string; ref: string };
    return await githubRequest(context, `/repos/${owner}/${repo}/commits/${ref}`);
  },
};
