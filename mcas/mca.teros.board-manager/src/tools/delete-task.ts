import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected } from '../lib';

export const deleteTask: ToolConfig = {
  description: 'Delete a task from the board. Sub-tasks become top-level tasks. Linked conversations are NOT deleted.',
  parameters: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task ID to delete',
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

    const result = await wsClient.queryConversations<any>('delete_task', {
      taskId,
    });

    return {
      success: true,
      taskId,
      deleted: true,
    };
  },
};
