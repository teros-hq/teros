import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const createFolder: ToolConfig = {
  description: 'Create a new folder in Google Drive.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the folder to create',
      },
      parentFolderId: {
        type: 'string',
        description: 'Optional: ID of the parent folder (default: root)',
      },
    },
    required: ['name'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { name, parentFolderId } = args as { name: string; parentFolderId?: string };

    return withAuthRetry(
      context,
      async () => {
        const fileMetadata: any = {
          name,
          mimeType: 'application/vnd.google-apps.folder',
        };

        if (parentFolderId) {
          fileMetadata.parents = [parentFolderId];
        }

        const response = await clients.drive.files.create({
          requestBody: fileMetadata,
          fields: 'id, name, webViewLink',
        });

        return response.data;
      },
      'create-folder',
    );
  },
};
