import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';

export const deleteBlock: ToolConfig = {
  description: 'Delete (archive) a block.',
  parameters: {
    type: 'object',
    properties: {
      blockId: {
        type: 'string',
        description: 'The ID of the block to delete',
      },
    },
    required: ['blockId'],
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const { blockId } = args as { blockId: string };

    const block = await client.blocks.delete({ block_id: blockId });
    return { success: true, block };
  },
};
