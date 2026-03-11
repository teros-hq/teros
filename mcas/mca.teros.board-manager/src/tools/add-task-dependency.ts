import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected } from '../lib';

export const addTaskDependency: ToolConfig = {
  description:
    'Add a dependency between two tasks. After this call, taskId depends on dependsOnTaskId ' +
    '(i.e. dependsOnTaskId must be completed before taskId can start). ' +
    'Cycle detection is performed automatically — if adding the dependency would create a cycle, ' +
    'an error is returned and the affected tasks are marked with status `circular_dependency`.',
  parameters: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task that gains the new dependency (the dependent task)',
      },
      dependsOnTaskId: {
        type: 'string',
        description: 'The task that taskId will depend on (must be completed first)',
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

    const result = await wsClient.queryConversations<any>('add_dependency', {
      taskId,
      dependsOnTaskId,
    });

    return {
      success: true,
      task: result.task,
    };
  },
};
