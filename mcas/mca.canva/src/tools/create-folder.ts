import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { canvaRequest } from '../lib';

export const createFolder: ToolConfig = {
  description: 'Create a new folder.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
      },
      parentFolderId: {
        type: 'string',
      },
    },
    required: ['name', 'parentFolderId'],
  },
  handler: async (args, context) => {
    const { name, parentFolderId } = args as {
      name: string;
      parentFolderId: string;
    };

    const body = {
      name,
      parent_folder_id: parentFolderId,
    };

    return canvaRequest(context, '/folders', { method: 'POST', body });
  },
};
