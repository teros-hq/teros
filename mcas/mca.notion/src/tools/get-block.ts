import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
import { BLOCK_DETAIL_FIELDS } from './_fields';
import { extractBlockShape, validateUuid } from './_notion-helpers';
import { resolveFields, wrapNotionCall } from './utils';

export const getBlock: ToolConfig = {
  description:
    'Retrieve a block. Returns curated { id, type, plainText, hasChildren, checked, language, caption, url, createdTime, lastEditedTime }. Params: blockId, fields?, includeRaw.',
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
        description: 'Return raw Notion block object. Default false.',
      },
    },
    required: ['blockId'],
  },
  annotations: { readOnlyHint: true, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const { blockId, fields, includeRaw } = args as {
      blockId: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateUuid(blockId, 'blockId');

    const raw: any = await wrapNotionCall(() => client.blocks.retrieve({ block_id: blockId }));
    const shape = extractBlockShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: BLOCK_DETAIL_FIELDS,
    });
  },
};
