import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const updateIssue: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Update an existing issue. Setting `state: "closed"` closes it (use `state_reason` for completed/not_planned). `labels` REPLACES the entire label set — use add-labels-to-issue to append.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      issue_number: { type: 'number', description: 'Issue number' },
      title: { type: 'string', description: 'New title' },
      body: { type: 'string', description: 'New body' },
      state: { type: 'string', enum: ['open', 'closed'], description: 'New state' },
      state_reason: {
        type: 'string',
        enum: ['completed', 'not_planned', 'reopened'],
        description: 'Reason when transitioning state (default: completed)',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'New labels (replaces existing)',
      },
    },
    required: ['owner', 'repo', 'issue_number'],
  },
  handler: async (args, context) => {
    const { owner, repo, issue_number, title, body, state, state_reason, labels } = args as {
      owner: string;
      repo: string;
      issue_number: number;
      title?: string;
      body?: string;
      state?: string;
      state_reason?: string;
      labels?: string[];
    };
    const updateData: Record<string, unknown> = {};
    if (title !== undefined) updateData.title = title;
    if (body !== undefined) updateData.body = body;
    if (state !== undefined) updateData.state = state;
    if (state_reason !== undefined) updateData.state_reason = state_reason;
    if (labels !== undefined) updateData.labels = labels;
    return await githubRequest(context, `/repos/${owner}/${repo}/issues/${issue_number}`, {
      method: 'PATCH',
      body: updateData,
    });
  },
};
