import { odooSearchRead, parseFilters } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const listTimesheets: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'List Odoo timesheet entries (account.analytic.line).',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'number', description: 'Filter by project ID' },
      taskId: { type: 'number', description: 'Filter by task ID' },
      employeeId: { type: 'number', description: 'Filter by employee ID' },
      dateFrom: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
      dateTo: { type: 'string', description: 'End date (YYYY-MM-DD)' },
      filters: { type: 'string', description: 'Additional comma-separated filters' },
      limit: { type: 'number', description: 'Maximum results (default: 50)' },
      offset: { type: 'number', description: 'Pagination offset' },
      order: { type: 'string', description: 'Order clause, e.g. date desc' },
    },
  },
  handler: async (
    args: {
      projectId?: number;
      taskId?: number;
      employeeId?: number;
      dateFrom?: string;
      dateTo?: string;
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
    if (args.taskId) {
      domain.push(['task_id', '=', args.taskId]);
    }
    if (args.employeeId) {
      domain.push(['employee_id', '=', args.employeeId]);
    }
    if (args.dateFrom) {
      domain.push(['date', '>=', args.dateFrom]);
    }
    if (args.dateTo) {
      domain.push(['date', '<=', args.dateTo]);
    }

    return odooSearchRead(context, 'account.analytic.line', {
      domain,
      fields: ['id', 'date', 'employee_id', 'project_id', 'task_id', 'name', 'unit_amount'],
      limit: args.limit,
      offset: args.offset,
      order: args.order,
    });
  },
};
