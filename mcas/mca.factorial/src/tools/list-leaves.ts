import { factorialRequest, buildQueryString } from '../lib';
import type { ToolDefinition } from '@teros/mca-sdk';

export const listLeaves: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'List time-off requests (leaves) with optional filters.',
  parameters: {
    type: 'object',
    properties: {
      employeeIds: { type: 'array', items: { type: 'number' }, description: 'Filter by employee IDs' },
      status: { type: 'string', description: 'Filter by status: pending, approved, rejected', enum: ['pending', 'approved', 'rejected'] },
      from: { type: 'string', description: 'Start date in ISO format (YYYY-MM-DD)' },
      to: { type: 'string', description: 'End date in ISO format (YYYY-MM-DD)' },
      limit: { type: 'number', description: 'Maximum results (default: 50)' },
      offset: { type: 'number', description: 'Pagination offset' },
    },
  },
  handler: async (args, context) => {
    const qs = buildQueryString({
      employee_ids: args.employeeIds,
      status: args.status,
      from: args.from,
      to: args.to,
      limit: args.limit,
      offset: args.offset,
    });
    return factorialRequest(context, `/timeoff/leaves${qs}`);
  },
};
