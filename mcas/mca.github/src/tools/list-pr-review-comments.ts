import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const listPrReviewComments: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List review comments (inline comments on diff) of a pull request. Returns array with {id, user, body, path, line, commit_id, created_at}.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      pull_number: { type: 'number', description: 'Pull request number' },
      sort: {
        type: 'string',
        enum: ['created', 'updated', 'created_at'],
        description: 'Sort field (default: created)',
      },
      direction: {
        type: 'string',
        enum: ['asc', 'desc'],
        description: 'Sort direction (default: asc)',
      },
      per_page: { type: 'number', description: 'Results per page (default: 30, max: 100)' },
      page: { type: 'number', description: 'Page index (1-based)' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
  handler: async (args, context) => {
    const { owner, repo, pull_number, sort, direction, per_page, page } = args as {
      owner: string;
      repo: string;
      pull_number: number;
      sort?: string;
      direction?: string;
      per_page?: number;
      page?: number;
    };
    return await githubRequest(
      context,
      `/repos/${owner}/${repo}/pulls/${pull_number}/comments`,
      { params: { sort, direction, per_page, page } },
    );
  },
};
