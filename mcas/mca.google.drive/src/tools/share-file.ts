import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const shareFile: ToolConfig = {
  description: 'Share a file or folder with specific permissions.',
  parameters: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'The ID of the file or folder to share',
      },
      emailAddress: {
        type: 'string',
        description: 'Email address to share with',
      },
      role: {
        type: 'string',
        enum: ['reader', 'commenter', 'writer', 'owner'],
        description: 'Permission role (default: reader)',
      },
    },
    required: ['fileId', 'emailAddress'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const {
      fileId,
      emailAddress,
      role = 'reader',
    } = args as {
      fileId: string;
      emailAddress: string;
      role?: string;
    };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.drive.permissions.create({
          fileId,
          requestBody: {
            type: 'user',
            role,
            emailAddress,
          },
          fields: 'id, type, role, emailAddress, displayName',
        });

        return response.data;
      },
      'share-file',
    );
  },
};
