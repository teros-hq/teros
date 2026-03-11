import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const listFiles: ToolConfig = {
  description:
    'List files and folders in Google Drive. Supports filtering by folder, file type, and search query.',
  parameters: {
    type: 'object',
    properties: {
      folderId: {
        type: 'string',
        description: 'Optional: List files within a specific folder (use folder ID)',
      },
      query: {
        type: 'string',
        description: 'Optional: Search query to filter files',
      },
      pageSize: {
        type: 'number',
        description: 'Optional: Number of results to return (default: 10, max: 100)',
        default: 10,
      },
      mimeType: {
        type: 'string',
        description:
          "Optional: Filter by MIME type (e.g., 'application/pdf', 'application/vnd.google-apps.folder')",
      },
    },
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const {
      folderId,
      query,
      pageSize = 10,
      mimeType,
    } = args as {
      folderId?: string;
      query?: string;
      pageSize?: number;
      mimeType?: string;
    };

    return withAuthRetry(
      context,
      async () => {
        let q = 'trashed=false';

        if (folderId) {
          q += ` and '${folderId}' in parents`;
        }

        if (query) {
          q += ` and name contains '${query}'`;
        }

        if (mimeType) {
          q += ` and mimeType='${mimeType}'`;
        }

        const response = await clients.drive.files.list({
          q,
          pageSize,
          fields:
            'files(id, name, mimeType, size, createdTime, modifiedTime, parents, webViewLink)',
          orderBy: 'modifiedTime desc',
        });

        return {
          files: response.data.files || [],
          nextPageToken: response.data.nextPageToken,
        };
      },
      'list-files',
    );
  },
};
