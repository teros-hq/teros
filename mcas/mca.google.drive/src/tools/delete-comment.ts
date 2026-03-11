import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const deleteComment: ToolConfig = {
  description: 'Delete a comment.',
  parameters: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'ID of the file',
      },
      commentId: {
        type: 'string',
        description: 'ID of the comment to delete',
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
        await clients.drive.comments.delete({
          fileId,
          commentId,
        });

        return {
          success: true,
          message: `Comment ${commentId} deleted successfully`,
        };
      },
      'delete-comment',
    );
  },
};
