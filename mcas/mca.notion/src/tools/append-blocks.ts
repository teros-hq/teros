import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
import { BLOCK_COMPACT_FIELDS } from './_fields';
import { extractBlockShape, validateUuid } from './_notion-helpers';
import { resolveFieldsList, wrapNotionWrite } from './utils';

export const appendBlocks: ToolConfig = {
  description:
    "Append blocks as children of a page or block. Supports paragraph/heading_1..heading_4 (H4 added in v5.16) and paragraph blocks accept an `icon` for inline emoji/external/file icons. `position` chooses placement: { type: 'after_block', after_block: { id } } | { type: 'start' } | { type: 'end' (default) }. Returns curated { blocks, appendedCount, parentId }. Not retryable (no idempotency key — creates duplicates on retry).",
  parameters: {
    type: 'object',
    properties: {
      blockId: {
        type: 'string',
        description: 'Parent page or block UUID.',
      },
      blocks: {
        type: 'array',
        items: { type: 'object' },
        description:
          "Array of Notion block objects in the standard shape `{ object: 'block', type: 'paragraph'|'heading_1'|...|'heading_4', <type>: { rich_text: [...] } }`. heading_4 added in v5.16. paragraph `icon` (v5.16) ONLY works when the paragraph is a direct child of a tab block — appending icon under a regular page returns 'Cannot set icon on a paragraph block that is not a direct child of a tab block'. Other types: bulleted_list_item, numbered_list_item, to_do, toggle, quote, callout, code, divider, image, video, file, pdf, bookmark, embed, equation, link_to_page, table, table_row, meeting_notes, synced_block.",
      },
      position: {
        type: 'object',
        description:
          "Optional placement. Default end. Shape: { type: 'after_block', after_block: { id } } | { type: 'start' } | { type: 'end' }.",
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Override default whitelist per returned block.',
      },
      includeRaw: {
        type: 'boolean',
        description: 'Return raw Notion blocks. Default false.',
      },
    },
    required: ['blockId', 'blocks'],
  },
  annotations: { readOnlyHint: false, version: '2.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const { blockId, blocks, position, fields, includeRaw } = args as {
      blockId: string;
      blocks: any[];
      position?: any;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateUuid(blockId, 'blockId');

    const params: any = { block_id: blockId, children: blocks };
    if (position) params.position = position;
    const response: any = await wrapNotionWrite(() => client.blocks.children.append(params));

    const shaped = response.results.map(extractBlockShape);
    const results = resolveFieldsList(shaped as any, response.results, {
      includeRaw,
      fields,
      defaultFields: BLOCK_COMPACT_FIELDS,
    });

    return {
      parentId: blockId,
      blocks: results,
      appendedCount: results.length,
    };
  },
};
