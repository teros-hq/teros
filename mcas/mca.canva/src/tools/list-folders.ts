import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { canvaRequest } from '../lib';

export const listFolders: ToolConfig = {
  description: 'List items in a folder.',
  parameters: {
    type: 'object',
    properties: {
      folderId: {
        type: 'string',
        description: "Folder ID ('root' for top-level)",
      },
      itemTypes: {
        type: 'array',
        items: { type: 'string' },
      },
      sortBy: {
        type: 'string',
      },
      continuation: {
        type: 'string',
      },
    },
    required: ['folderId'],
  },
  handler: async (args, context) => {
    const { folderId, itemTypes, sortBy, continuation } = args as {
      folderId: string;
      itemTypes?: string[];
      sortBy?: string;
      continuation?: string;
    };

    const params = new URLSearchParams();
    if (itemTypes) params.append('item_types', itemTypes.join(','));
    if (sortBy) params.append('sort_by', sortBy);
    if (continuation) params.append('continuation', continuation);

    const queryString = params.toString();
    return canvaRequest(
      context,
      `/folders/${folderId}/items${queryString ? `?${queryString}` : ''}`,
    );
  },
};
