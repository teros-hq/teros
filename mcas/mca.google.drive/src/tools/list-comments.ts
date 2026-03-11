import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const listComments: ToolConfig = {
  description: 'List all comments on a file.',
  parameters: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'ID of the file',
      },
      includeDeleted: {
        type: 'boolean',
        description: 'Optional: Include deleted comments (default: false)',
      },
      pageSize: {
        type: 'number',
        description: 'Optional: Maximum number of comments to return (default: 100)',
      },
    },
    required: ['fileId'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const {
      fileId,
      includeDeleted = false,
      pageSize = 100,
    } = args as {
      fileId: string;
      includeDeleted?: boolean;
      pageSize?: number;
    };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.drive.comments.list({
          fileId,
          includeDeleted,
          pageSize,
          fields: 'comments(id, content, author, createdTime, modifiedTime, resolved, replies)',
        });

        return {
          comments: response.data.comments || [],
        };
      },
      'list-comments',
    );
  },
};
