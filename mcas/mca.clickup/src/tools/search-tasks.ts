import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { clickupRequest, formatTask } from '../lib';

export const searchTasks: ToolConfig = {
  description: 'Search for tasks across a ClickUp workspace.',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string', description: 'The workspace (team) ID to search in' },
      query: { type: 'string', description: 'Search query text' },
      page: { type: 'number', description: 'Page number (default: 0)' },
    },
    required: ['workspaceId', 'query'],
  },
  handler: async (args, context) => {
    const { workspaceId, query, page = 0 } = args as {
      workspaceId: string;
      query: string;
      page?: number;
    };

    const data = await clickupRequest(context, `/team/${workspaceId}/task`, {
      params: { search: query, page },
    }) as { tasks: any[] };

    return {
      workspaceId,
      query,
      count: data.tasks.length,
      tasks: data.tasks.map(formatTask),
    };
  },
};
