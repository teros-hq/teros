import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const createBranch: ToolConfig = {
  description: 'Create a new branch from a reference',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      branch: { type: 'string', description: 'New branch name' },
      from_branch: { type: 'string', description: 'Source branch name (default: main)' },
    },
    required: ['owner', 'repo', 'branch'],
  },
  handler: async (args, context) => {
    const { owner, repo, branch, from_branch = 'main' } = args as {
      owner: string; repo: string; branch: string; from_branch?: string;
    };
    const refData = await githubRequest(context, `/repos/${owner}/${repo}/git/refs/heads/${from_branch}`) as any;
    return await githubRequest(context, `/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${branch}`, sha: refData.object.sha },
    });
  },
};
