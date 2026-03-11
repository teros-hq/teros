import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const deleteFile: ToolConfig = {
  description: 'Delete a file or folder from Google Drive.',
  parameters: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'The ID of the file or folder to delete',
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
        await clients.drive.files.delete({ fileId });

        return {
          success: true,
          message: `File/folder ${fileId} deleted successfully`,
        };
      },
      'delete-file',
    );
  },
};
