import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const createPull: ToolConfig = {
  description: 'Create a new pull request',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Pull request title' },
      body: { type: 'string', description: 'Pull request description' },
      head: { type: 'string', description: 'Branch name containing changes' },
      base: { type: 'string', description: 'Branch name to merge into (default: main)' },
      draft: { type: 'boolean', description: 'Create as draft PR (default: false)' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  handler: async (args, context) => {
    const { owner, repo, title, body, head, base, draft } = args as {
      owner: string; repo: string; title: string; body?: string; head: string; base: string; draft?: boolean;
    };
    return await githubRequest(context, `/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      body: { title, body, head, base, draft: draft ?? false },
    });
  },
};
