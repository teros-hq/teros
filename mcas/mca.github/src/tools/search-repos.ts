import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { PAGE_PARAMS, PAGED_RESULT_NOTE, type PageArgs, fieldPayload, curateRepo, pagedRequest } from '../lib/curate';

export const searchRepos: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: `Search repositories on GitHub. ${PAGED_RESULT_NOTE}`,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (e.g., "react language:javascript stars:>1000")' },
      sort: { type: 'string', enum: ['stars', 'forks', 'help-wanted-issues', 'updated'], description: 'Sort results by' },
      ...PAGE_PARAMS,
    },
    required: ['query'],
  },
  handler: async (args, context) => {
    const a = args as PageArgs & { query: string; sort?: string };
    if (!a.query || a.query.trim() === '') throw new Error('`query` must be a non-empty search query.');
    return pagedRequest(context, '/search/repositories', a, { q: a.query, sort: a.sort }, fieldPayload('items'), curateRepo);
  },
};
