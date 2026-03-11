import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected } from '../lib';

export const updateTask: ToolConfig = {
  description: 'Update task properties (title, description, priority, tags).',
  parameters: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task ID to update',
      },
      title: {
        type: 'string',
        description: 'New task title',
      },
      description: {
        type: 'string',
        description: 'New task description',
      },
      priority: {
        type: 'string',
        enum: ['urgent', 'high', 'medium', 'low'],
        description: 'New priority',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'New tags (replaces existing)',
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

    const result = await wsClient.queryConversations<any>('update_task', {
      taskId,
      title: args?.title,
      description: args?.description,
      priority: args?.priority,
      tags: args?.tags,
    });

    return {
      success: true,
      task: result.task,
    };
  },
};
