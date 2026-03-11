import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected } from '../lib';

export const moveMyTask: ToolConfig = {
  description: 'Move one of your assigned tasks to a different column on the board. You can only move tasks assigned to you.',
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
  handler: async (args, context) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const taskId = args?.taskId as string;
    const columnId = args?.columnId as string;
    const agentId = context?.execution?.agentId;

    if (!taskId || !columnId) {
      throw new Error('taskId and columnId are required');
    }

    if (!agentId) {
      throw new Error('Agent ID not found in context');
    }

    const result = await wsClient.queryConversations<any>('move_my_task', {
      taskId,
      columnId,
      position: args?.position,
      agentId,
    });

    return {
      success: true,
      task: result.task,
    };
  },
};
