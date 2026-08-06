import { odooSearchRead, parseFilters } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const listTasks: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'List Odoo project tasks.',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'number', description: 'Filter by project ID' },
      filters: { type: 'string', description: 'Additional comma-separated filters' },
      limit: { type: 'number', description: 'Maximum results (default: 50)' },
      offset: { type: 'number', description: 'Pagination offset' },
      order: { type: 'string', description: 'Order clause, e.g. date_deadline asc' },
    },
  },
  handler: async (
    args: {
      projectId?: number;
      filters?: string;
      limit?: number;
      offset?: number;
      order?: string;
    },
    context: ToolContext,
  ) => {
    const domain = parseFilters(args.filters);
    if (args.projectId) {
      domain.push(['project_id', '=', args.projectId]);
    }

    return odooSearchRead(context, 'project.task', {
      domain,
      fields: ['id', 'name', 'project_id', 'user_ids', 'stage_id', 'date_deadline', 'state'],
      limit: args.limit,
      offset: args.offset,
      order: args.order,
    });
  },
};
