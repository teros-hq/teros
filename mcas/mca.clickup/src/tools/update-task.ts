import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { clickupRequest, formatTask, mapPriority } from '../lib';

export const updateTask: ToolConfig = {
  description: 'Update an existing ClickUp task.',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The task ID to update' },
      name: { type: 'string', description: 'New task name' },
      description: { type: 'string', description: 'New task description' },
      priority: {
        type: 'string',
        description: 'New priority: urgent, high, normal, low',
        enum: ['urgent', 'high', 'normal', 'low'],
      },
      status: { type: 'string', description: 'New status' },
      dueDate: { type: 'number', description: 'New due date as Unix timestamp in milliseconds' },
      startDate: { type: 'number', description: 'New start date as Unix timestamp in milliseconds' },
      timeEstimate: { type: 'number', description: 'New time estimate in milliseconds' },
    },
    required: ['taskId'],
  },
  handler: async (args, context) => {
    const { taskId, name, description, priority, status, dueDate, startDate, timeEstimate } = args as {
      taskId: string;
      name?: string;
      description?: string;
      priority?: string;
      status?: string;
      dueDate?: number;
      startDate?: number;
      timeEstimate?: number;
    };

    const body: Record<string, any> = {};
    if (name) body.name = name;
    if (description !== undefined) body.description = description;
    if (priority) body.priority = mapPriority(priority);
    if (status) body.status = status;
    if (dueDate !== undefined) body.due_date = dueDate;
    if (startDate !== undefined) body.start_date = startDate;
    if (timeEstimate !== undefined) body.time_estimate = timeEstimate;

    const data = await clickupRequest(context, `/task/${taskId}`, { method: 'PUT', body });
    return formatTask(data);
  },
};
