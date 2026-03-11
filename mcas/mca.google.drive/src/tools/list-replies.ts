import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const listReplies: ToolConfig = {
  description: 'List all replies to a comment.',
  parameters: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'ID of the file',
      },
      commentId: {
        type: 'string',
        description: 'ID of the comment',
      },
      pageSize: {
        type: 'number',
        description: 'Optional: Maximum number of replies to return (default: 100)',
      },
    },
    required: ['fileId', 'commentId'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const {
      fileId,
      commentId,
      pageSize = 100,
    } = args as {
      fileId: string;
      commentId: string;
      pageSize?: number;
    };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.drive.replies.list({
          fileId,
          commentId,
          pageSize,
          fields: 'replies(id, content, author, createdTime, modifiedTime, action)',
        });

        return {
          replies: response.data.replies || [],
        };
      },
      'list-replies',
    );
  },
};
