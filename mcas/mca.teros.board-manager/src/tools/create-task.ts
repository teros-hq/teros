import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected } from '../lib';

export const createTask: ToolConfig = {
  description: 'Create a new task on a project board. Defaults to backlog column.',
  parameters: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID',
      },
      title: {
        type: 'string',
        description: 'Task title',
      },
      description: {
        type: 'string',
        description: 'Task description (supports markdown)',
      },
      priority: {
        type: 'string',
        enum: ['urgent', 'high', 'medium', 'low'],
        description: 'Task priority (default: medium)',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags for categorization',
      },
      assignedAgentId: {
        type: 'string',
        description: 'Agent ID to assign the task to',
      },
      columnId: {
        type: 'string',
        description: 'Column ID to place the task in (default: backlog)',
      },
      parentTaskId: {
        type: 'string',
        description: 'Parent task ID for sub-tasks',
      },
    },
    required: ['projectId', 'title'],
  },
  handler: async (args) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const projectId = args?.projectId as string;
    const title = args?.title as string;
    if (!projectId || !title) {
      throw new Error('projectId and title are required');
    }

    const result = await wsClient.queryConversations<any>('create_task', {
      projectId,
      title,
      description: args?.description,
      priority: args?.priority,
      tags: args?.tags,
      assignedAgentId: args?.assignedAgentId,
      columnId: args?.columnId,
      parentTaskId: args?.parentTaskId,
    });

    return {
      success: true,
      task: result.task,
    };
  },
};
