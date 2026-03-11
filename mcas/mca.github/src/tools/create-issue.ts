import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const createIssue: ToolConfig = {
  description: 'Create a new issue in a repository',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue description (supports markdown)' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Array of label names' },
      assignees: { type: 'array', items: { type: 'string' }, description: 'Array of GitHub usernames to assign' },
    },
    required: ['owner', 'repo', 'title'],
  },
  handler: async (args, context) => {
    const { owner, repo, title, body, labels, assignees } = args as {
      owner: string; repo: string; title: string; body?: string; labels?: string[]; assignees?: string[];
    };
    return await githubRequest(context, `/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      body: { title, body, labels, assignees },
    });
  },
};
