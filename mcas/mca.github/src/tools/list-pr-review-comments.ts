import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { assertOwnerRepo } from '../lib';
import { PAGE_PARAMS, PAGED_RESULT_NOTE, type PageArgs, arrayPayload, curateReviewComment, pagedRequest } from '../lib/curate';

export const listPrReviewComments: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: `List review comments (inline, on the diff) of a pull request. ${PAGED_RESULT_NOTE}`,
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      pull_number: { type: 'number', description: 'Pull request number' },
      sort: { type: 'string', enum: ['created', 'updated', 'created_at'], description: 'Sort field (default: created)' },
      direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction (default: asc)' },
      ...PAGE_PARAMS,
    },
    required: ['owner', 'repo', 'pull_number'],
  },
  handler: async (args, context) => {
    const a = args as PageArgs & { owner: string; repo: string; pull_number: number; sort?: string; direction?: string };
    assertOwnerRepo(a.owner, a.repo);
    return pagedRequest(context, `/repos/${a.owner}/${a.repo}/pulls/${a.pull_number}/comments`, a, { sort: a.sort, direction: a.direction }, arrayPayload, curateReviewComment);
  },
};
