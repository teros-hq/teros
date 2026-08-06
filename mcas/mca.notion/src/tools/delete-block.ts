import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
import { BLOCK_COMPACT_FIELDS } from './_fields';
import { extractBlockShape, validateUuid } from './_notion-helpers';
import { resolveFields, wrapNotionWrite } from './utils';

export const deleteBlock: ToolConfig = {
  description:
    'Delete (archive) a block. Returns the curated archived block { id, type, archived, lastEditedTime }. Idempotent — retries are safe.',
  parameters: {
    type: 'object',
    properties: {
      blockId: {
        type: 'string',
        description: 'Block UUID.',
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
    required: ['blockId'],
  },
  annotations: { readOnlyHint: false, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const { blockId, fields, includeRaw } = args as {
      blockId: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateUuid(blockId, 'blockId');

    const raw: any = await wrapNotionWrite(() => client.blocks.delete({ block_id: blockId }));
    const shape = extractBlockShape(raw);
    return {
      block: resolveFields(shape as any, raw, {
        includeRaw,
        fields,
        defaultFields: BLOCK_COMPACT_FIELDS,
      }),
      deleted: true,
    };
  },
};
