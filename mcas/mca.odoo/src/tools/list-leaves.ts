import { odooSearchRead, parseFilters } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const listLeaves: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'List Odoo time-off requests (hr.leave).',
  parameters: {
    type: 'object',
    properties: {
      employeeId: { type: 'number', description: 'Filter by employee ID' },
      state: { type: 'string', description: 'Filter by state: draft, confirm, validate, refuse' },
      filters: { type: 'string', description: 'Additional comma-separated filters' },
      limit: { type: 'number', description: 'Maximum results (default: 50)' },
      offset: { type: 'number', description: 'Pagination offset' },
      order: { type: 'string', description: 'Order clause, e.g. date_from desc' },
    },
  },
  handler: async (
    args: {
      employeeId?: number;
      state?: string;
      filters?: string;
      limit?: number;
      offset?: number;
      order?: string;
    },
    context: ToolContext,
  ) => {
    const domain = parseFilters(args.filters);
    if (args.employeeId) {
      domain.push(['employee_id', '=', args.employeeId]);
    }
    if (args.state) {
      domain.push(['state', '=', args.state]);
    }

    return odooSearchRead(context, 'hr.leave', {
      domain,
      fields: ['id', 'employee_id', 'holiday_status_id', 'date_from', 'date_to', 'state', 'number_of_days'],
      limit: args.limit,
      offset: args.offset,
      order: args.order,
    });
  },
};
