import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
import { BLOCK_DETAIL_FIELDS } from './_fields';
import { extractBlockShape, trimBlocks, validateUuid } from './_notion-helpers';
import { resolveFieldsList, sanitizeLimit, wrapNotionCall } from './utils';

export const getBlocks: ToolConfig = {
  description:
    'List direct children of a page/block with pagination. Returns curated { id, type, plainText, hasChildren, ... }. Use when you need block IDs + structure. For rendered markdown use `get-block-children` or `get-page-content`. Params: blockId, limit (1-100, def 25), cursor, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      blockId: {
        type: 'string',
        description: 'Page or parent block UUID.',
      },
      limit: {
        type: 'number',
        description: 'Blocks per page. Min 1, max 100, default 25.',
      },
      cursor: {
        type: 'string',
        description: 'Notion pagination cursor from a previous nextCursor.',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Override default whitelist per block.',
      },
      includeRaw: {
        type: 'boolean',
        description:
          'Return raw Notion block objects (trimmed to maxDepth=2, maxChars=10_000). Default false.',
      },
    },
    required: ['blockId'],
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const { blockId, limit, cursor, fields, includeRaw } = args as {
      blockId: string;
      limit?: number;
      cursor?: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateUuid(blockId, 'blockId');

    const pageSize = sanitizeLimit(limit, { max: 100, default: 25 });
    const response: any = await wrapNotionCall(() =>
      client.blocks.children.list({
        block_id: blockId,
        page_size: pageSize,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    );

    const shaped = response.results.map(extractBlockShape);
    const rawTrimmed = includeRaw ? trimBlocks(response.results) : response.results;
    const results = resolveFieldsList(shaped as any, rawTrimmed, {
      includeRaw,
      fields,
      defaultFields: BLOCK_DETAIL_FIELDS,
    });

    return {
      blocks: results,
      total: results.length,
      hasMore: response.has_more,
      nextCursor: response.next_cursor,
    };
  },
};
