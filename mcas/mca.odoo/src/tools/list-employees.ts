import { odooSearchRead, parseFilters } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const listEmployees: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'List Odoo employees (hr.employee).',
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
    return odooSearchRead(context, 'hr.employee', {
      domain: parseFilters(args.filters),
      fields: ['id', 'name', 'work_email', 'work_phone', 'department_id', 'job_id', 'parent_id'],
      limit: args.limit,
      offset: args.offset,
      order: args.order,
    });
  },
};
