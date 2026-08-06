import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import {
  ALL_DRIVES_LIST,
  ensureAuthenticated,
  initializeGoogleClients,
  withAuthRetry,
} from '../lib';
import { escapeQueryValue } from './_query';

export const searchFiles: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Search for files in Google Drive by name, content, or properties.',
  parameters: {
    type: 'object',
    properties: {
      searchTerm: {
        type: 'string',
        description:
          'Filename match (Drive `name contains`: prefix/token, not substring). For advanced filters (owners, dates, fullText) use the list-files `driveQuery` parameter.',
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
          `name contains '${escapeQueryValue(searchTerm)}' and trashed = false` +
          (mimeType ? ` and mimeType = '${escapeQueryValue(mimeType)}'` : '');

        const response = await clients.drive.files.list({
          ...ALL_DRIVES_LIST,
          pageSize: maxResults,
          q: query,
          fields: 'files(id, name, mimeType, size, modifiedTime, webViewLink, driveId), incompleteSearch',
          orderBy: 'modifiedTime desc',
        });

        return {
          files: response.data.files || [],
          ...(response.data.incompleteSearch ? { incompleteSearch: true } : {}),
        };
      },
      'search-files',
    );
  },
};
