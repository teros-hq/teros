import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected } from '../lib';

export const removeTaskDependency: ToolConfig = {
  description:
    'Remove a dependency between two tasks. After this call, taskId no longer depends on dependsOnTaskId. ' +
    'This operation is idempotent — if the dependency does not exist, the task is returned unchanged.',
  parameters: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task that currently has the dependency',
      },
      dependsOnTaskId: {
        type: 'string',
        description: 'The task to remove from taskId\'s dependencies',
      },
    },
    required: ['taskId', 'dependsOnTaskId'],
  },
  handler: async (args) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const taskId = args?.taskId as string;
    const dependsOnTaskId = args?.dependsOnTaskId as string;
    if (!taskId || !dependsOnTaskId) {
      throw new Error('taskId and dependsOnTaskId are required');
    }

    const result = await wsClient.queryConversations<any>('remove_dependency', {
      taskId,
      dependsOnTaskId,
    });

    return {
      success: true,
      task: result.task,
    };
  },
};
