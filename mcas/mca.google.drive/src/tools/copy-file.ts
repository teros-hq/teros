import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const copyFile: ToolConfig = {
  description: 'Create a copy of a file in Google Drive.',
  parameters: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'ID of the file to copy',
      },
      name: {
        type: 'string',
        description: 'Optional: Name for the copy',
      },
      parentFolderId: {
        type: 'string',
        description: 'Optional: Copy to specific folder',
      },
    },
    required: ['fileId'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { fileId, name, parentFolderId } = args as {
      fileId: string;
      name?: string;
      parentFolderId?: string;
    };

    return withAuthRetry(
      context,
      async () => {
        const fileMetadata: any = {};

        if (name) {
          fileMetadata.name = name;
        }

        if (parentFolderId) {
          fileMetadata.parents = [parentFolderId];
        }

        const response = await clients.drive.files.copy({
          fileId,
          requestBody: fileMetadata,
          fields: 'id, name, webViewLink',
        });

        return response.data;
      },
      'copy-file',
    );
  },
};
