import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const searchFiles: ToolConfig = {
  description: 'Search for files in Google Drive by name, content, or properties.',
  parameters: {
    type: 'object',
    properties: {
      searchTerm: {
        type: 'string',
        description: 'Search term to find in file names',
      },
      mimeType: {
        type: 'string',
        description: 'Optional: Filter by MIME type',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results (default: 20)',
      },
    },
    required: ['searchTerm'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const {
      searchTerm,
      mimeType,
      maxResults = 20,
    } = args as {
      searchTerm: string;
      mimeType?: string;
      maxResults?: number;
    };

    return withAuthRetry(
      context,
      async () => {
        const query =
          `name contains '${searchTerm}' and trashed = false` +
          (mimeType ? ` and mimeType = '${mimeType}'` : '');

        const response = await clients.drive.files.list({
          pageSize: maxResults,
          q: query,
          fields: 'files(id, name, mimeType, size, modifiedTime, webViewLink)',
          orderBy: 'modifiedTime desc',
        });

        return { files: response.data.files || [] };
      },
      'search-files',
    );
  },
};
