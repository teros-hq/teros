import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';

export const updateBlock: ToolConfig = {
  description: "Update a block's content. The content structure depends on the block type.",
  parameters: {
    type: 'object',
    properties: {
      blockId: {
        type: 'string',
        description: 'The ID of the block to update',
      },
      content: {
        type: 'object',
        description: 'Block content object (depends on block type, see Notion API docs)',
      },
    },
    required: ['blockId', 'content'],
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);

    const { blockId, content } = args as {
      blockId: string;
      content: Record<string, any>;
    };

    const updateData = {
      block_id: blockId,
      ...content,
    };

    const block = await client.blocks.update(updateData as any);
    return block;
  },
};
