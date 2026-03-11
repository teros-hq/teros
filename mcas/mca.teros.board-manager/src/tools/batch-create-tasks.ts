import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected } from '../lib';

export const batchCreateTasks: ToolConfig = {
  description: 'Create multiple tasks at once on a project board. Atomic operation — all succeed or all fail. Max 100 tasks.',
  parameters: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID',
      },
      tasks: {
        type: 'array',
        description: 'Array of task objects to create',
        items: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: 'Task title',
            },
            description: {
              type: 'string',
              description: 'Task description',
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
              description: 'Agent ID to assign',
            },
            columnId: {
              type: 'string',
              description: 'Column ID (default: backlog)',
            },
            parentTaskId: {
              type: 'string',
              description: 'Parent task ID for sub-tasks',
            },
          },
          required: ['title'],
        },
      },
    },
    required: ['projectId', 'tasks'],
  },
  handler: async (args) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const projectId = args?.projectId as string;
    const tasks = args?.tasks as any[];
    if (!projectId || !tasks || !Array.isArray(tasks)) {
      throw new Error('projectId and tasks array are required');
    }

    const result = await wsClient.queryConversations<any>('batch_create_tasks', {
      projectId,
      tasks,
    });

    return {
      success: true,
      projectId,
      tasks: result.tasks,
      count: result.count,
    };
  },
};
