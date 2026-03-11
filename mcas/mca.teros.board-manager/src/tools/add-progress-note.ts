import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected } from '../lib';

export const addProgressNote: ToolConfig = {
  description:
    'Add a progress note to a task. Use this to post updates about what you are doing ' +
    'on a task. Progress notes are visible in the task detail and on the board.',
  parameters: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task ID to add a note to',
      },
      text: {
        type: 'string',
        description: 'The progress note text',
      },
    },
    required: ['taskId', 'text'],
  },
  handler: async (args, context) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const taskId = args?.taskId as string;
    const text = args?.text as string;
    if (!taskId || !text) {
      throw new Error('taskId and text are required');
    }

    const actor = context?.execution?.agentId || 'unknown';

    const result = await wsClient.queryConversations<any>('add_progress_note', {
      taskId,
      text,
      actor,
    });

    return {
      success: true,
      task: result.task,
    };
  },
};
