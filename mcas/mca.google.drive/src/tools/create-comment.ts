import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const createComment: ToolConfig = {
  description: 'Create a comment on a file.',
  parameters: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'ID of the file to comment on',
      },
      content: {
        type: 'string',
        description: 'The text content of the comment',
      },
    },
    required: ['fileId', 'content'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { fileId, content } = args as { fileId: string; content: string };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.drive.comments.create({
          fileId,
          fields: 'id, content, author, createdTime',
          requestBody: {
            content,
          },
        });

        return response.data;
      },
      'create-comment',
    );
  },
};
