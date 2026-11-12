import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { assertOwnerRepo } from '../lib';
import { PAGE_PARAMS, PAGED_RESULT_NOTE, type PageArgs, arrayPayload, curateCommit, pagedRequest } from '../lib/curate';

export const listCommits: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: `List commits for a repository. ${PAGED_RESULT_NOTE}`,
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      sha: { type: 'string', description: 'SHA or branch name to list commits from' },
      ...PAGE_PARAMS,
    },
    required: ['owner', 'repo'],
  },
  handler: async (args, context) => {
    const a = args as PageArgs & { owner: string; repo: string; sha?: string };
    assertOwnerRepo(a.owner, a.repo);
    return pagedRequest(context, `/repos/${a.owner}/${a.repo}/commits`, a, { sha: a.sha }, arrayPayload, curateCommit);
  },
};
