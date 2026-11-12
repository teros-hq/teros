import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { assertOwnerRepo } from '../lib';
import { PAGE_PARAMS, PAGED_RESULT_NOTE, type PageArgs, arrayPayload, curatePull, pagedRequest } from '../lib/curate';

export const listPulls: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: `List pull requests for a repository. ${PAGED_RESULT_NOTE}`,
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state (default: open)' },
      sort: { type: 'string', enum: ['created', 'updated', 'popularity', 'long-running'], description: 'Sort by (default: created)' },
      ...PAGE_PARAMS,
    },
    required: ['owner', 'repo'],
  },
  handler: async (args, context) => {
    const a = args as PageArgs & { owner: string; repo: string; state?: string; sort?: string };
    assertOwnerRepo(a.owner, a.repo);
    return pagedRequest(context, `/repos/${a.owner}/${a.repo}/pulls`, a, { state: a.state, sort: a.sort }, arrayPayload, curatePull);
  },
};
