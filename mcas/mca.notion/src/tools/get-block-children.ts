import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { formatBlocksAsText, getAllBlocks, getNotionClient } from '../lib';

export const getBlockChildren: ToolConfig = {
  description:
    'Retrieve children blocks of a block or page. Returns formatted text by default. Set includeBlocks=true only when you need block IDs for editing operations.',
  parameters: {
    type: 'object',
    properties: {
      blockId: {
        type: 'string',
        description: 'The ID of the block or page',
      },
      includeBlocks: {
        type: 'boolean',
        description:
          'Include raw block data with IDs (default: false). Only set to true when you need to edit/insert blocks.',
      },
    },
    required: ['blockId'],
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const { blockId, includeBlocks = false } = args as { blockId: string; includeBlocks?: boolean };

    const blocks = await getAllBlocks(client, blockId);
    const textContent = formatBlocksAsText(blocks);

    if (includeBlocks) {
      return {
        textContent,
        blocks,
      };
    }

    return {
      textContent,
    };
  },
};
