import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
import { BLOCK_COMPACT_FIELDS } from './_fields';
import { extractBlockShape, validateUuid } from './_notion-helpers';
import { resolveFieldsList, wrapNotionWrite } from './utils';

export const createAdvancedBlocks: ToolConfig = {
  description:
    "Create an advanced block. Supported types: 'callout' (icon + colour), 'toggle' (children), 'synced_block', 'meeting_notes' (summary + transcript), 'paragraph' (with optional `icon` per v5.16). `content` must match the Notion shape for the given `blockType`. Not retryable.",
  parameters: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'Target page UUID.',
      },
      blockType: {
        type: 'string',
        description: "'callout' | 'toggle' | 'synced_block' | 'meeting_notes' | 'paragraph'.",
        enum: ['callout', 'toggle', 'synced_block', 'meeting_notes', 'paragraph'],
      },
      content: {
        type: 'object',
        description:
          "Notion block body (rich_text, children, icon, ...). For 'paragraph' you may include an `icon: { type: 'emoji'|'external'|'file', ... }` (v5.16+).",
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Override default whitelist.',
      },
      includeRaw: {
        type: 'boolean',
        description: 'Return raw Notion blocks. Default false.',
      },
    },
    required: ['pageId', 'blockType', 'content'],
  },
  annotations: { readOnlyHint: false, version: '2.0.0', stability: 'experimental' },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const { pageId, blockType, content, fields, includeRaw } = args as {
      pageId: string;
      blockType: 'callout' | 'toggle' | 'synced_block' | 'meeting_notes' | 'paragraph';
      content: Record<string, any>;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateUuid(pageId, 'pageId');

    const block: any = {
      object: 'block',
      type: blockType,
      [blockType]: content,
    };
    const response: any = await wrapNotionWrite(() =>
      client.blocks.children.append({
        block_id: pageId,
        children: [block],
      }),
    );

    const shaped = response.results.map(extractBlockShape);
    const results = resolveFieldsList(shaped as any, response.results, {
      includeRaw,
      fields,
      defaultFields: BLOCK_COMPACT_FIELDS,
    });

    return {
      parentId: pageId,
      blockType,
      blocks: results,
      appendedCount: results.length,
    };
  },
};
