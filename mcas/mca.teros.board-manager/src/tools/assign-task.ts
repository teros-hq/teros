import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected } from '../lib';

export const assignTask: ToolConfig = {
  description: 'Assign or unassign an agent to a task. Pass null or omit agentId to unassign.',
  parameters: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task ID',
      },
      agentId: {
        type: 'string',
        description: 'Agent ID to assign (omit or null to unassign)',
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

    const result = await wsClient.queryConversations<any>('assign_task', {
      taskId,
      agentId: args?.agentId ?? null,
    });

    return {
      success: true,
      task: result.task,
    };
  },
};
