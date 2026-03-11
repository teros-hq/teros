import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const getComment: ToolConfig = {
  description: 'Get a specific comment by ID.',
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
    },
    required: ['fileId', 'commentId'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { fileId, commentId } = args as { fileId: string; commentId: string };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.drive.comments.get({
          fileId,
          commentId,
          fields: 'id, content, author, createdTime, modifiedTime, resolved, replies',
        });

        return response.data;
      },
      'get-comment',
    );
  },
};
