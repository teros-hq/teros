import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { createReadStream, existsSync } from 'fs';
import { basename } from 'path';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const uploadFile: ToolConfig = {
  description: 'Upload a local file to Google Drive.',
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Local path of the file to upload',
      },
      parentFolderId: {
        type: 'string',
        description: 'Optional: ID of the folder to upload to (default: root)',
      },
      fileName: {
        type: 'string',
        description: 'Optional: Custom name for the file (default: original filename)',
      },
    },
    required: ['filePath'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { filePath, parentFolderId, fileName } = args as {
      filePath: string;
      parentFolderId?: string;
      fileName?: string;
    };

    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    return withAuthRetry(
      context,
      async () => {
        const fileMetadata: any = {
          name: fileName || basename(filePath),
        };

        if (parentFolderId) {
          fileMetadata.parents = [parentFolderId];
        }

        const media = {
          mimeType: 'application/octet-stream',
          body: createReadStream(filePath),
        };

        const response = await clients.drive.files.create({
          requestBody: fileMetadata,
          media,
          fields: 'id, name, mimeType, size, webViewLink',
        });

        return response.data;
      },
      'upload-file',
    );
  },
};
