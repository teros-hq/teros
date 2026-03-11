import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { clickupRequest } from '../lib';

export const getLists: ToolConfig = {
  description: 'Get all lists in a ClickUp folder.',
  parameters: {
    type: 'object',
    properties: {
      folderId: { type: 'string', description: 'The folder ID' },
      archived: { type: 'boolean', description: 'Include archived lists (default: false)' },
    },
    required: ['folderId'],
  },
  handler: async (args, context) => {
    const { folderId, archived = false } = args as { folderId: string; archived?: boolean };
    const data = await clickupRequest(context, `/folder/${folderId}/list`, {
      params: { archived: String(archived) },
    }) as { lists: any[] };
    return {
      folderId,
      lists: data.lists.map((list) => ({
        id: list.id,
        name: list.name,
        orderIndex: list.orderindex,
        taskCount: list.task_count,
        archived: list.archived,
        status: list.status,
        priority: list.priority,
        dueDate: list.due_date,
        startDate: list.start_date,
      })),
    };
  },
};
