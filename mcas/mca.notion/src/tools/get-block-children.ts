import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { formatBlocksAsText, getAllBlocks, getNotionClient } from '../lib';
import { validateUuid } from './_notion-helpers';
import { wrapNotionCall } from './utils';

export const getBlockChildren: ToolConfig = {
  description:
    'DEPRECATED — prefer `get-page-content` (markdown) or `get-blocks` (paginated raw). Kept for back-compat: returns { textContent } as recursive markdown. Pass includeBlockIds=true to embed `<!-- block: id -->` comments before each top-level block.',
  parameters: {
    type: 'object',
    properties: {
      blockId: {
        type: 'string',
        description: 'Block or page UUID.',
      },
      includeBlockIds: {
        type: 'boolean',
        description: 'Embed `<!-- block: id -->` comments in the markdown. Default false.',
      },
    },
    required: ['blockId'],
  },
  annotations: { readOnlyHint: true,
    version: '1.1.0',
    stability: 'deprecated',
    deprecationMessage:
      'Use `get-page-content` for markdown output or `get-blocks` for paginated raw blocks with plainText extracted per block.',
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const { blockId, includeBlockIds = false, includeRaw } = args as {
      blockId: string;
      includeBlockIds?: boolean;
      includeRaw?: boolean;
    };
    validateUuid(blockId, 'blockId');

    const blocks = await wrapNotionCall(() => getAllBlocks(client, blockId));
    if (includeRaw) return blocks;
    const textContent = formatBlocksAsText(blocks, 0, includeBlockIds);

    return { textContent };
  },
};
