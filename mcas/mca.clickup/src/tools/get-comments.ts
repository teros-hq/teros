import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { clickupRequest } from '../lib';

export const getComments: ToolConfig = {
  description: 'Get all comments on a ClickUp task.',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The task ID' },
    },
    required: ['taskId'],
  },
  handler: async (args, context) => {
    const { taskId } = args as { taskId: string };
    const data = await clickupRequest(context, `/task/${taskId}/comment`) as { comments: any[] };

    return {
      taskId,
      count: data.comments.length,
      comments: data.comments.map((c) => ({
        id: c.id,
        commentText: c.comment_text,
        user: c.user ? { id: c.user.id, username: c.user.username, email: c.user.email } : null,
        resolved: c.resolved,
        date: c.date ? new Date(parseInt(c.date)).toISOString() : null,
      })),
    };
  },
};
