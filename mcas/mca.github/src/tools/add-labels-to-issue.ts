import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const addLabelsToIssue: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Add labels to an issue or pull request (PRs are issues in the API). Returns the full label set after the addition.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      issue_number: { type: 'number', description: 'Issue or pull request number' },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Label names to add (case sensitive). Existing labels are preserved.',
      },
    },
    required: ['owner', 'repo', 'issue_number', 'labels'],
  },
  handler: async (args, context) => {
    const { owner, repo, issue_number, labels } = args as {
      owner: string;
      repo: string;
      issue_number: number;
      labels: string[];
    };
    if (!Array.isArray(labels) || labels.length === 0) {
      throw new Error('`labels` must be a non-empty array of label names.');
    }
    if (labels.some((l) => typeof l !== 'string' || l.trim() === '')) {
      throw new Error('Each entry in `labels` must be a non-empty string.');
    }
    return await githubRequest(
      context,
      `/repos/${owner}/${repo}/issues/${issue_number}/labels`,
      { method: 'POST', body: { labels } },
    );
  },
};
