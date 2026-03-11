import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const createReply: ToolConfig = {
  description: 'Create a reply to a comment. Can also be used to resolve a comment.',
  parameters: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'ID of the file',
      },
      commentId: {
        type: 'string',
        description: 'ID of the comment to reply to',
      },
      content: {
        type: 'string',
        description: 'The reply text content',
      },
      action: {
        type: 'string',
        enum: ['resolve', 'reopen'],
        description: "Optional: Action to perform. Use 'resolve' to resolve the comment.",
      },
    },
    required: ['fileId', 'commentId', 'content'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { fileId, commentId, content, action } = args as {
      fileId: string;
      commentId: string;
      content: string;
      action?: string;
    };

    return withAuthRetry(
      context,
      async () => {
        const requestBody: any = { content };

        if (action) {
          requestBody.action = action;
        }

        const response = await clients.drive.replies.create({
          fileId,
          commentId,
          fields: 'id, content, author, createdTime, action',
          requestBody,
        });

        return response.data;
      },
      'create-reply',
    );
  },
};
