import type { ToolConfig } from '@teros/mca-sdk';
import { brevoRequest } from '../lib/brevo-client';
import { clampInt, shapeList } from './_helpers';

interface ListListsResponse {
  lists?: unknown[];
  count?: number;
}

/**
 * list-lists — GET /contacts/lists.
 */
export const listLists: ToolConfig = {
  description:
    'List contact lists from Brevo (GET /contacts/lists). Returns { lists:[{id,name,folderId,totalSubscribers,uniqueSubscribers,totalBlacklisted}], count, limit, offset }. Params: limit? (1-50, default 50), offset? (default 0).',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Max lists to return (1-50, default 50).',
        default: 50,
      },
      offset: {
        type: 'number',
        description: 'Index of the first list for pagination (default 0).',
        default: 0,
      },
    },
  },
  annotations: {
    version: '1.0.0',
    stability: 'stable',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const limit = clampInt(a.limit, 1, 50, 50);
    const offset = clampInt(a.offset, 0, Number.MAX_SAFE_INTEGER, 0);

    const res = await brevoRequest<ListListsResponse>(context, '/contacts/lists', {
      query: { limit, offset },
    });

    const lists = (res.lists ?? []).map(shapeList);
    return {
      lists,
      count: typeof res.count === 'number' ? res.count : lists.length,
      limit,
      offset,
    };
  },
};
