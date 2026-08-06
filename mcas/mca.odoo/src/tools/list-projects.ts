import { odooSearchRead, parseFilters } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const listProjects: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'List Odoo projects.',
  parameters: {
    type: 'object',
    properties: {
      filters: { type: 'string', description: 'Comma-separated filters' },
      limit: { type: 'number', description: 'Maximum results (default: 50)' },
      offset: { type: 'number', description: 'Pagination offset' },
      order: { type: 'string', description: 'Order clause, e.g. name asc' },
    },
  },
  handler: async (
    args: { filters?: string; limit?: number; offset?: number; order?: string },
    context: ToolContext,
  ) => {
    return odooSearchRead(context, 'project.project', {
      domain: parseFilters(args.filters),
      fields: ['id', 'name', 'partner_id', 'user_id', 'date_start', 'date'],
      limit: args.limit,
      offset: args.offset,
      order: args.order,
    });
  },
};
