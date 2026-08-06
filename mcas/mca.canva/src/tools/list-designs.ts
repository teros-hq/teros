import type { ToolConfig } from '@teros/mca-sdk';
import { buildDesignShape, canvaRequest } from '../lib';
import { DESIGN_COMPACT_FIELDS } from './_fields';
import { resolveFieldsList, sanitizeLimit, wrapCanvaCall } from './utils';

export const listDesigns: ToolConfig = {
  description:
    "List designs in the user's account with search/sort/pagination. Returns curated rows with thumbnail URL for inline preview. Params: query?, ownership? (any|owned|shared), sortBy?, limit (1-100, def 25), continuation?, fields?, includeRaw.",
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search term to filter designs.' },
      ownership: {
        type: 'string',
        enum: ['any', 'owned', 'shared'],
        description: 'Filter by ownership.',
      },
      sortBy: {
        type: 'string',
        enum: [
          'relevance',
          'modified_descending',
          'modified_ascending',
          'title_descending',
          'title_ascending',
        ],
      },
      limit: { type: 'number', description: 'Max results. Min 1, max 100, default 25.' },
      continuation: { type: 'string', description: 'Pagination token from previous response.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva response. Default false.' },
    },
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { query, ownership, sortBy, limit, continuation, fields, includeRaw } = args as {
      query?: string;
      ownership?: string;
      sortBy?: string;
      limit?: number;
      continuation?: string;
      fields?: string[];
      includeRaw?: boolean;
    };

    const params = new URLSearchParams();
    if (query) params.append('query', query);
    if (ownership) params.append('ownership', ownership);
    if (sortBy) params.append('sort_by', sortBy);
    params.append('limit', String(sanitizeLimit(limit, { max: 100, default: 25 })));
    if (continuation) params.append('continuation', continuation);

    const raw: any = await wrapCanvaCall(() => canvaRequest(context, `/designs?${params.toString()}`));
    const items: any[] = Array.isArray(raw?.items) ? raw.items : [];
    const shaped = items.map((it) => buildDesignShape(it));
    const designs = resolveFieldsList(shaped as any[], items, {
      includeRaw,
      fields,
      defaultFields: DESIGN_COMPACT_FIELDS,
    });

    return {
      designs,
      total: designs.length,
      hasMore: !!raw?.continuation,
      nextCursor: raw?.continuation ?? null,
    };
  },
};
