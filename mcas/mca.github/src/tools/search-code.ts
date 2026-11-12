import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { PAGE_PARAMS, PAGED_RESULT_NOTE, type PageArgs, fieldPayload, curateCodeItem, pagedRequest } from '../lib/curate';

export const searchCode: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: `Search for code across GitHub repositories (file name, path and repository of each match; read a match with get-file-content). ${PAGED_RESULT_NOTE}`,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (e.g., "addClass in:file language:js repo:jquery/jquery")' },
      ...PAGE_PARAMS,
    },
    required: ['query'],
  },
  handler: async (args, context) => {
    const a = args as PageArgs & { query: string };
    if (!a.query || a.query.trim() === '') throw new Error('`query` must be a non-empty search query.');
    return pagedRequest(context, '/search/code', a, { q: a.query }, fieldPayload('items'), curateCodeItem);
  },
};
