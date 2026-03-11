import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected } from '../lib';

export const getTaskDependencies: ToolConfig = {
  description:
    'Get the dependencies of a task — i.e. the list of task IDs that must be completed ' +
    'before the given task can start. Returns the dependency task IDs and their full details.',
  parameters: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task ID to get dependencies for',
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

    const result = await wsClient.queryConversations<any>('get_task', {
      taskId,
    });

    const task = result.task;
    const dependencies: string[] = task?.dependencies ?? [];

    return {
      taskId,
      dependencies,
      count: dependencies.length,
    };
  },
};
