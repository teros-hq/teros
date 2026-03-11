import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected } from '../lib';

export const moveTask: ToolConfig = {
  description: 'Move a task to a different column on the board.',
  parameters: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task ID to move',
      },
      columnId: {
        type: 'string',
        description: 'Target column ID',
      },
      position: {
        type: 'number',
        description: 'Position within the column (optional, defaults to end)',
      },
    },
    required: ['taskId', 'columnId'],
  },
  handler: async (args) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const taskId = args?.taskId as string;
    const columnId = args?.columnId as string;
    if (!taskId || !columnId) {
      throw new Error('taskId and columnId are required');
    }

    const result = await wsClient.queryConversations<any>('move_task', {
      taskId,
      columnId,
      position: args?.position,
    });

    return {
      success: true,
      task: result.task,
    };
  },
};
