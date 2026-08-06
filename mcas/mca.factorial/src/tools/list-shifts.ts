import { factorialRequest, buildQueryString } from '../lib';
import type { ToolDefinition } from '@teros/mca-sdk';

export const listShifts: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'List all attendance shifts with optional filters.',
  parameters: {
    type: 'object',
    properties: {
      employeeIds: { type: 'array', items: { type: 'number' }, description: 'Filter by employee IDs' },
      from: { type: 'string', description: 'Start date in ISO format (YYYY-MM-DD)' },
      to: { type: 'string', description: 'End date in ISO format (YYYY-MM-DD)' },
      limit: { type: 'number', description: 'Maximum results (default: 50)' },
      offset: { type: 'number', description: 'Pagination offset' },
    },
  },
  handler: async (args, context) => {
    const qs = buildQueryString({
      employee_ids: args.employeeIds,
      from: args.from,
      to: args.to,
      limit: args.limit,
      offset: args.offset,
    });
    return factorialRequest(context, `/attendance/shifts${qs}`);
  },
};
