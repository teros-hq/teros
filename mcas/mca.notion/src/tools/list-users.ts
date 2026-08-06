import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
import { USER_FIELDS } from './_fields';
import { extractUserShape } from './_notion-helpers';
import { resolveFieldsList, sanitizeLimit, wrapNotionCall } from './utils';

export const listUsers: ToolConfig = {
  description:
    'List workspace users. Returns curated rows { id, name, type, avatarUrl, email, bot }. Params: limit (1-100, def 50), startCursor, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Results per page. Min 1, max 100, default 50.',
      },
      startCursor: {
        type: 'string',
        description: 'Notion pagination cursor.',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Override default whitelist per row.',
      },
      includeRaw: {
        type: 'boolean',
        description: 'Return raw Notion response. Default false.',
      },
    },
  },
  annotations: { readOnlyHint: true, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const { limit, startCursor, cursor, fields, includeRaw } = args as {
      limit?: number;
      startCursor?: string;
      cursor?: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    const effectiveCursor = startCursor ?? cursor;

    const pageSize = sanitizeLimit(limit, { max: 100, default: 50 });
    const response: any = await wrapNotionCall(() =>
      client.users.list({
        page_size: pageSize,
        ...(effectiveCursor ? { start_cursor: effectiveCursor } : {}),
      }),
    );

    const shaped = response.results.map(extractUserShape);
    const users = resolveFieldsList(shaped as any, response.results, {
      includeRaw,
      fields,
      defaultFields: USER_FIELDS,
    });

    return {
      users,
      total: users.length,
      hasMore: response.has_more,
      nextCursor: response.next_cursor,
    };
  },
};
