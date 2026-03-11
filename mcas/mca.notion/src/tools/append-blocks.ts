import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';

export const appendBlocks: ToolConfig = {
  description: 'Append content blocks to a page or block.',
  parameters: {
    type: 'object',
    properties: {
      blockId: {
        type: 'string',
        description: 'The ID of the page or block to append to',
      },
      blocks: {
        type: 'array',
        description: 'Array of block objects to append (see Notion API docs for block format)',
        items: { type: 'object' },
      },
    },
    required: ['blockId', 'blocks'],
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);

    const { blockId, blocks } = args as {
      blockId: string;
      blocks: any[];
    };

    const response = await client.blocks.children.append({
      block_id: blockId,
      children: blocks,
    });

    return response;
  },
};
