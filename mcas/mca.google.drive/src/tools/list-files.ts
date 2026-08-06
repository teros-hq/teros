import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import {
  ALL_DRIVES_LIST,
  ensureAuthenticated,
  initializeGoogleClients,
  withAuthRetry,
} from '../lib';
import { buildListQuery } from './_query';

export const listFiles: ToolConfig = {
  annotations: { readOnlyHint: true },
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
        description:
          "Optional: filename match (Drive `name contains`: prefix/token, e.g. 'Hello' matches 'HelloWorld' but 'World' does not). NOT a raw Drive query — for owner/date/fullText filters use `driveQuery`.",
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
      driveQuery: {
        type: 'string',
        description:
          "Optional advanced: a raw Google Drive API v3 query clause, AND-ed with the other filters. Use for filters `query` can't express, e.g. \"not 'me' in owners\", \"modifiedTime > '2024-01-01T00:00:00'\", \"fullText contains 'budget'\". Inside a literal, escape a single quote as \\' (Drive syntax, NOT '' ) — for a plain filename match prefer the `query` param, which escapes for you.",
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
      driveQuery,
    } = args as {
      folderId?: string;
      query?: string;
      pageSize?: number;
      mimeType?: string;
      driveQuery?: string;
    };

    if (driveQuery !== undefined && driveQuery.trim() === '') {
      throw new Error('driveQuery must be a non-empty Drive query clause when provided');
    }

    return withAuthRetry(
      context,
      async () => {
        const q = buildListQuery({ folderId, query, mimeType, driveQuery });

        const response = await clients.drive.files.list({
          ...ALL_DRIVES_LIST,
          q,
          pageSize,
          fields:
            'files(id, name, mimeType, size, createdTime, modifiedTime, parents, webViewLink, driveId), nextPageToken, incompleteSearch',
          orderBy: 'modifiedTime desc',
        });

        return {
          files: response.data.files || [],
          nextPageToken: response.data.nextPageToken,
          ...(response.data.incompleteSearch ? { incompleteSearch: true } : {}),
        };
      },
      'list-files',
    );
  },
};
