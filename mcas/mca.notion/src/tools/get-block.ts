import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';

export const getBlock: ToolConfig = {
  description: 'Retrieve a specific block by its ID.',
  parameters: {
    type: 'object',
    properties: {
      blockId: {
        type: 'string',
        description: 'The ID of the block',
      },
    },
    required: ['blockId'],
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const { blockId } = args as { blockId: string };

    const block = await client.blocks.retrieve({ block_id: blockId });
    return block;
  },
};
