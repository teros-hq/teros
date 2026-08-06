import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
import { SEARCH_RESULT_FIELDS } from './_fields';
import { extractSearchResultShape } from './_notion-helpers';
import { resolveFieldsList, sanitizeLimit, wrapNotionCall } from './utils';

export const search: ToolConfig = {
  description:
    'Search pages & databases by title. Returns curated rows { id, object, url, title, icon, lastEditedTime }. Params: query, filter?, sort?, limit (1-100, def 50), startCursor, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query text',
      },
      filter: {
        type: 'string',
        description:
          "Limit to 'page' (pages only) or 'data_source' (databases — note: Notion API 2025-09-03+ uses 'data_source', NOT 'database').",
        enum: ['page', 'data_source'],
      },
      sort: {
        type: 'string',
        description: "Sort by 'last_edited_time' (descending)",
        enum: ['last_edited_time'],
      },
      limit: {
        type: 'number',
        description: 'Results per page. Min 1, max 100, default 50.',
      },
      startCursor: {
        type: 'string',
        description: 'Notion pagination cursor from previous response.nextCursor.',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Override default whitelist. Pass field names from the curated shape.',
      },
      includeRaw: {
        type: 'boolean',
        description: 'Return raw Notion API response. Default false.',
      },
    },
    required: ['query'],
  },
  annotations: { readOnlyHint: true, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const {
      query,
      filter,
      sort,
      limit,
      startCursor,
      fields,
      includeRaw,
    } = args as {
      query: string;
      filter?: 'page' | 'data_source';
      sort?: 'last_edited_time';
      limit?: number;
      startCursor?: string;
      fields?: string[];
      includeRaw?: boolean;
    };

    const pageSize = sanitizeLimit(limit, { max: 100, default: 50 });
    const searchParams: any = { query, page_size: pageSize };
    if (filter) searchParams.filter = { value: filter, property: 'object' };
    if (sort) searchParams.sort = { direction: 'descending', timestamp: sort };
    if (startCursor) searchParams.start_cursor = startCursor;

    const response: any = await wrapNotionCall(() => client.search(searchParams));

    const shaped = response.results.map(extractSearchResultShape);
    const results = resolveFieldsList(shaped as any, response.results, {
      includeRaw,
      fields,
      defaultFields: SEARCH_RESULT_FIELDS,
    });

    return {
      results,
      total: results.length,
      hasMore: response.has_more,
      nextCursor: response.next_cursor,
    };
  },
};
