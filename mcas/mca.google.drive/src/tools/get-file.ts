import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const getFile: ToolConfig = {
  description: 'Get detailed information about a specific file or folder.',
  parameters: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'The ID of the file or folder to get information about',
      },
    },
    required: ['fileId'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { fileId } = args as { fileId: string };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.drive.files.get({
          fileId,
          fields:
            'id, name, mimeType, size, createdTime, modifiedTime, parents, webViewLink, webContentLink, description, owners',
        });

        return response.data;
      },
      'get-file',
    );
  },
};
