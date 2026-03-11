import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { clickupRequest } from '../lib';

export const addComment: ToolConfig = {
  description: 'Add a comment to a ClickUp task.',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The task ID to comment on' },
      commentText: { type: 'string', description: 'The comment text (markdown supported)' },
      notifyAll: {
        type: 'boolean',
        description: 'Notify all assignees of the task (default: false)',
      },
    },
    required: ['taskId', 'commentText'],
  },
  handler: async (args, context) => {
    const { taskId, commentText, notifyAll = false } = args as {
      taskId: string;
      commentText: string;
      notifyAll?: boolean;
    };

    const data = await clickupRequest(context, `/task/${taskId}/comment`, {
      method: 'POST',
      body: { comment_text: commentText, notify_all: notifyAll },
    }) as any;

    return {
      id: data.id,
      taskId,
      histId: data.hist_id,
    };
  },
};
