import { odooCreate, odooRead } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const createProjectTask: ToolDefinition = {
  annotations: { readOnlyHint: false },
  description: 'Create a new task in an Odoo project.',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'number', description: 'Project ID' },
      name: { type: 'string', description: 'Task name' },
      userId: { type: 'number', description: 'Assigned user ID' },
      dateDeadline: { type: 'string', description: 'Deadline (ISO 8601)' },
      description: { type: 'string', description: 'Task description (HTML supported)' },
      values: {
        type: 'object',
        description: 'Additional field values',
        additionalProperties: true,
      },
    },
    required: ['projectId', 'name'],
  },
  handler: async (
    args: {
      projectId: number;
      name: string;
      userId?: number;
      dateDeadline?: string;
      description?: string;
      values?: Record<string, unknown>;
    },
    context: ToolContext,
  ) => {
    const values: Record<string, unknown> = {
      project_id: args.projectId,
      name: args.name,
      user_ids: args.userId ? [[6, 0, [args.userId]]] : undefined,
      date_deadline: args.dateDeadline,
      description: args.description,
      ...(args.values ?? {}),
    };

    const taskId = await odooCreate(context, 'project.task', values);
    return odooRead(context, 'project.task', taskId, ['id', 'name', 'project_id', 'stage_id']);
  },
};
