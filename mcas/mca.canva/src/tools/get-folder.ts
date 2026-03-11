import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { canvaRequest } from '../lib';

export const getFolder: ToolConfig = {
  description: 'Get metadata for a folder.',
  parameters: {
    type: 'object',
    properties: {
      folderId: {
        type: 'string',
      },
    },
    required: ['folderId'],
  },
  handler: async (args, context) => {
    const { folderId } = args as { folderId: string };
    return canvaRequest(context, `/folders/${folderId}`);
  },
};
