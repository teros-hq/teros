import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected } from '../lib';

export const getTask: ToolConfig = {
  description: 'Get detailed information about a specific task by its ID.',
  parameters: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task ID to retrieve',
      },
    },
    required: ['taskId'],
  },
  handler: async (args) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const taskId = args?.taskId as string;
    if (!taskId) {
      throw new Error('taskId is required');
    }

    const result = await wsClient.queryConversations<any>('get_task', { taskId });

    return {
      success: true,
      task: result.task,
    };
  },
};
