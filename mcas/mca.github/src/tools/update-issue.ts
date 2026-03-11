import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const updateIssue: ToolConfig = {
  description: 'Update an existing issue',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      issue_number: { type: 'number', description: 'Issue number' },
      title: { type: 'string', description: 'New title' },
      body: { type: 'string', description: 'New body' },
      state: { type: 'string', enum: ['open', 'closed'], description: 'New state' },
      labels: { type: 'array', items: { type: 'string' }, description: 'New labels (replaces existing)' },
    },
    required: ['owner', 'repo', 'issue_number'],
  },
  handler: async (args, context) => {
    const { owner, repo, issue_number, title, body, state, labels } = args as {
      owner: string; repo: string; issue_number: number; title?: string; body?: string; state?: string; labels?: string[];
    };
    const updateData: Record<string, unknown> = {};
    if (title) updateData.title = title;
    if (body) updateData.body = body;
    if (state) updateData.state = state;
    if (labels) updateData.labels = labels;
    return await githubRequest(context, `/repos/${owner}/${repo}/issues/${issue_number}`, {
      method: 'PATCH',
      body: updateData,
    });
  },
};
