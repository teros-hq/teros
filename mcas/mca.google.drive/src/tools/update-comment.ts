import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const updateComment: ToolConfig = {
  description: 'Update the content of a comment.',
  parameters: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'ID of the file',
      },
      commentId: {
        type: 'string',
        description: 'ID of the comment to update',
      },
      content: {
        type: 'string',
        description: 'New content for the comment',
      },
    },
    required: ['fileId', 'commentId', 'content'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { fileId, commentId, content } = args as {
      fileId: string;
      commentId: string;
      content: string;
    };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.drive.comments.update({
          fileId,
          commentId,
          fields: 'id, content, author, modifiedTime',
          requestBody: {
            content,
          },
        });

        return response.data;
      },
      'update-comment',
    );
  },
};
