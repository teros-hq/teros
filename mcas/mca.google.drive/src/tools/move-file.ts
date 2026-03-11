import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const moveFile: ToolConfig = {
  description: 'Move a file or folder to a different location in Google Drive.',
  parameters: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'ID of the file/folder to move',
      },
      newParentId: {
        type: 'string',
        description: 'ID of the destination folder',
      },
    },
    required: ['fileId', 'newParentId'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { fileId, newParentId } = args as { fileId: string; newParentId: string };

    return withAuthRetry(
      context,
      async () => {
        // Get current parents
        const file = await clients.drive.files.get({
          fileId,
          fields: 'parents',
        });

        const previousParents = file.data.parents?.join(',');

        // Move file
        const response = await clients.drive.files.update({
          fileId,
          addParents: newParentId,
          removeParents: previousParents,
          fields: 'id, name, parents, webViewLink',
        });

        return response.data;
      },
      'move-file',
    );
  },
};
