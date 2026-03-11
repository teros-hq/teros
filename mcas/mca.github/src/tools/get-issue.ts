import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const getIssue: ToolConfig = {
  description: 'Get details of a specific issue',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      issue_number: { type: 'number', description: 'Issue number' },
    },
    required: ['owner', 'repo', 'issue_number'],
  },
  handler: async (args, context) => {
    const { owner, repo, issue_number } = args as { owner: string; repo: string; issue_number: number };
    return await githubRequest(context, `/repos/${owner}/${repo}/issues/${issue_number}`);
  },
};
