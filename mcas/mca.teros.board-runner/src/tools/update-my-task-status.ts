import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected } from '../lib';

export const updateMyTaskStatus: ToolConfig = {
  description:
    'Update the semantic status of one of your assigned tasks. You can only update status of tasks assigned to you. ' +
    'Status is decoupled from column position. When set to "review" or "done", the task is automatically moved to the matching column.',
  parameters: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task ID to update',
      },
      status: {
        type: 'string',
        description: 'New status for the task',
        enum: ['idle', 'assigned', 'working', 'blocked', 'review', 'done'],
      },
    },
    required: ['taskId', 'status'],
  },
  handler: async (args, context) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const taskId = args?.taskId as string;
    const status = args?.status as string;
    const agentId = context?.execution?.agentId;

    if (!taskId || !status) {
      throw new Error('taskId and status are required');
    }

    if (!agentId) {
      throw new Error('Agent ID not found in context');
    }

    const result = await wsClient.queryConversations<any>('update_my_task_status', {
      taskId,
      status,
      agentId,
    });

    return {
      success: true,
      task: result.task,
      previousStatus: result.previousStatus,
    };
  },
};
