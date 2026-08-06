import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
import { BLOCK_DETAIL_FIELDS } from './_fields';
import { extractBlockShape, sanitiseBlockForUpdate, validateUuid } from './_notion-helpers';
import { resolveFields, wrapNotionCall } from './utils';

const TEXT_BLOCK_TYPES = new Set([
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  'quote',
  'callout',
  'code',
]);

export const updateBlock: ToolConfig = {
  description:
    "Replace `oldText` with `newText` in a block's text. Reads the block, verifies `oldText` exists (exact match), then updates preserving annotations. Errors with 'Text not found in block. No changes made.' when oldText doesn't match. Returns the curated block { id, type, plainText, lastEditedTime }.",
  parameters: {
    type: 'object',
    properties: {
      blockId: {
        type: 'string',
        description: 'Block UUID.',
      },
      oldText: {
        type: 'string',
        description: 'Exact text currently in the block that should be replaced.',
      },
      newText: {
        type: 'string',
        description: 'Replacement text.',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Override default whitelist.',
      },
      includeRaw: {
        type: 'boolean',
        description: 'Return raw Notion block. Default false.',
      },
    },
    required: ['blockId', 'oldText', 'newText'],
  },
  annotations: { readOnlyHint: false, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const { blockId, oldText, newText, fields, includeRaw } = args as {
      blockId: string;
      oldText: string;
      newText: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateUuid(blockId, 'blockId');

    const block: any = await wrapNotionCall(() => client.blocks.retrieve({ block_id: blockId }));
    const blockType = block.type;
    if (!TEXT_BLOCK_TYPES.has(blockType)) {
      throw new Error(
        `Block type '${blockType}' does not support text editing. Block ID: ${blockId}`,
      );
    }
    const richText: any[] = block[blockType]?.rich_text;
    if (!richText || !Array.isArray(richText)) {
      throw new Error(`Text not found in block. No changes made. Block ID: ${blockId}`);
    }

    const segmentIndex = richText.findIndex(
      (segment: any) =>
        typeof segment.plain_text === 'string' && segment.plain_text.includes(oldText),
    );
    if (segmentIndex === -1) {
      throw new Error(`Text not found in block. No changes made. Block ID: ${blockId}`);
    }

    const segment = richText[segmentIndex];
    const updatedSegment = {
      ...segment,
      text: { ...segment.text, content: segment.text.content.replace(oldText, newText) },
      plain_text: segment.plain_text.replace(oldText, newText),
    };
    const updatedRichText = [
      ...richText.slice(0, segmentIndex),
      updatedSegment,
      ...richText.slice(segmentIndex + 1),
    ];

    // Notion returns `icon: null` / `cover: null` on blocks that don't set
    // them, but rejects those same nulls on PATCH with:
    //   body.paragraph.icon should be an object or 'undefined', instead was 'null'
    // Strip null/undefined fields before writing back.
    const updatedBody = sanitiseBlockForUpdate(blockType, {
      ...block[blockType],
      rich_text: updatedRichText,
    });
    const raw: any = await wrapNotionCall(() =>
      client.blocks.update({
        block_id: blockId,
        ...updatedBody,
      } as any),
    );

    const shape = extractBlockShape(raw);
    return {
      block: resolveFields(shape as any, raw, {
        includeRaw,
        fields,
        defaultFields: BLOCK_DETAIL_FIELDS,
      }),
      oldText,
      newText,
    };
  },
};
