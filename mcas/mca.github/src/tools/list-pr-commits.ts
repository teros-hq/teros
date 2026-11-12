import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { assertOwnerRepo } from '../lib';
import { PAGE_PARAMS, PAGED_RESULT_NOTE, type PageArgs, arrayPayload, curateCommit, pagedRequest } from '../lib/curate';

export const listPrCommits: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: `List commits on a pull request. ${PAGED_RESULT_NOTE}`,
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      pull_number: { type: 'number', description: 'Pull request number' },
      ...PAGE_PARAMS,
    },
    required: ['owner', 'repo', 'pull_number'],
  },
  handler: async (args, context) => {
    const a = args as PageArgs & { owner: string; repo: string; pull_number: number };
    assertOwnerRepo(a.owner, a.repo);
    return pagedRequest(context, `/repos/${a.owner}/${a.repo}/pulls/${a.pull_number}/commits`, a, {}, arrayPayload, curateCommit);
  },
};
