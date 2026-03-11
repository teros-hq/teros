import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { clickupRequest, formatTask } from '../lib';

export const getTasks: ToolConfig = {
  description: 'Get tasks from a ClickUp list with optional filters.',
  parameters: {
    type: 'object',
    properties: {
      listId: { type: 'string', description: 'The list ID to get tasks from' },
      archived: { type: 'boolean', description: 'Include archived tasks (default: false)' },
      page: { type: 'number', description: 'Page number for pagination (default: 0)' },
      orderBy: {
        type: 'string',
        description: 'Field to order by: id, created, updated, due_date (default: created)',
      },
      reverse: { type: 'boolean', description: 'Reverse the order (default: false)' },
      subtasks: { type: 'boolean', description: 'Include subtasks (default: false)' },
      statuses: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter by status names',
      },
    },
    required: ['listId'],
  },
  handler: async (args, context) => {
    const { listId, archived = false, page = 0, orderBy, reverse, subtasks = false, statuses } = args as {
      listId: string;
      archived?: boolean;
      page?: number;
      orderBy?: string;
      reverse?: boolean;
      subtasks?: boolean;
      statuses?: string[];
    };

    const params: Record<string, any> = { archived: String(archived), page, subtasks: String(subtasks) };
    if (orderBy) params.order_by = orderBy;
    if (reverse) params.reverse = 'true';
    if (statuses?.length) params['statuses[]'] = statuses.join(',');

    const data = await clickupRequest(context, `/list/${listId}/task`, { params }) as { tasks: any[] };

    return {
      listId,
      count: data.tasks.length,
      tasks: data.tasks.map(formatTask),
    };
  },
};
