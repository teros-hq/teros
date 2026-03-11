import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const addIssueComment: ToolConfig = {
  description: 'Add a comment to an issue',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      issue_number: { type: 'number', description: 'Issue number' },
      body: { type: 'string', description: 'Comment text (supports markdown)' },
    },
    required: ['owner', 'repo', 'issue_number', 'body'],
  },
  handler: async (args, context) => {
    const { owner, repo, issue_number, body } = args as {
      owner: string; repo: string; issue_number: number; body: string;
    };
    return await githubRequest(context, `/repos/${owner}/${repo}/issues/${issue_number}/comments`, {
      method: 'POST',
      body: { body },
    });
  },
};
