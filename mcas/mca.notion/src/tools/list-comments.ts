import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';

export const listComments: ToolConfig = {
  description: 'List comments on a page or block.',
  parameters: {
    type: 'object',
    properties: {
      blockId: {
        type: 'string',
        description: 'The block or page ID',
      },
    },
    required: ['blockId'],
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const { blockId } = args as { blockId: string };

    const comments = await client.comments.list({ block_id: blockId });
    return comments;
  },
};
