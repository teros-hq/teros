import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { canvaRequest } from '../lib';

export const moveItem: ToolConfig = {
  description: 'Move an item to another folder.',
  parameters: {
    type: 'object',
    properties: {
      itemId: {
        type: 'string',
      },
      toFolderId: {
        type: 'string',
      },
    },
    required: ['itemId', 'toFolderId'],
  },
  handler: async (args, context) => {
    const { itemId, toFolderId } = args as {
      itemId: string;
      toFolderId: string;
    };

    const body = {
      item_id: itemId,
      to_folder_id: toFolderId,
    };

    await canvaRequest(context, '/folders/move', { method: 'POST', body });
    return { success: true, message: 'Item moved successfully' };
  },
};
