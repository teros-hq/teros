import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { clickupRequest, formatTask, mapPriority } from '../lib';

export const createTask: ToolConfig = {
  description: 'Create a new task in a ClickUp list.',
  parameters: {
    type: 'object',
    properties: {
      listId: { type: 'string', description: 'The list ID where the task will be created' },
      name: { type: 'string', description: 'Task name/title' },
      description: { type: 'string', description: 'Task description (markdown supported)' },
      priority: {
        type: 'string',
        description: 'Task priority: urgent, high, normal, low',
        enum: ['urgent', 'high', 'normal', 'low'],
      },
      status: { type: 'string', description: 'Task status (must match a status in the list)' },
      assignees: {
        type: 'array',
        items: { type: 'number' },
        description: 'Array of user IDs to assign',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of tag names',
      },
      dueDate: { type: 'number', description: 'Due date as Unix timestamp in milliseconds' },
      startDate: { type: 'number', description: 'Start date as Unix timestamp in milliseconds' },
      timeEstimate: { type: 'number', description: 'Time estimate in milliseconds' },
      parentId: { type: 'string', description: 'Parent task ID to create as a subtask' },
    },
    required: ['listId', 'name'],
  },
  handler: async (args, context) => {
    const { listId, name, description, priority, status, assignees, tags, dueDate, startDate, timeEstimate, parentId } = args as {
      listId: string;
      name: string;
      description?: string;
      priority?: string;
      status?: string;
      assignees?: number[];
      tags?: string[];
      dueDate?: number;
      startDate?: number;
      timeEstimate?: number;
      parentId?: string;
    };

    const body: Record<string, any> = { name };
    if (description) body.description = description;
    if (priority) body.priority = mapPriority(priority);
    if (status) body.status = status;
    if (assignees) body.assignees = assignees;
    if (tags) body.tags = tags.map((t) => ({ name: t }));
    if (dueDate) body.due_date = dueDate;
    if (startDate) body.start_date = startDate;
    if (timeEstimate) body.time_estimate = timeEstimate;
    if (parentId) body.parent = parentId;

    const data = await clickupRequest(context, `/list/${listId}/task`, { method: 'POST', body });
    return formatTask(data);
  },
};
