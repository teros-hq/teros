import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected } from '../lib';

export const listTasks: ToolConfig = {
  description: 'List tasks in a project with optional filters by column, status, assignee, or tags.',
  parameters: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID to list tasks from',
      },
      columnId: {
        type: 'string',
        description: 'Filter by column ID (optional)',
      },
      status: {
        type: 'string',
        enum: ['idle', 'assigned', 'working', 'blocked', 'review', 'done'],
        description: 'Filter by task status (optional)',
      },
      assignedAgentId: {
        type: 'string',
        description: 'Filter by assigned agent ID (optional)',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter by tags — returns tasks that have ALL specified tags (optional)',
      },
    },
    required: ['projectId'],
  },
  handler: async (args) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const projectId = args?.projectId as string;
    if (!projectId) {
      throw new Error('projectId is required');
    }

    const result = await wsClient.queryConversations<any>('list_tasks', {
      projectId,
      columnId: args?.columnId,
      status: args?.status,
      assignedAgentId: args?.assignedAgentId,
      tags: args?.tags,
    });

    return {
      success: true,
      tasks: result.tasks,
      count: result.tasks?.length ?? 0,
    };
  },
};
