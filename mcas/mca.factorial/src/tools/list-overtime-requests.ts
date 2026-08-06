import { factorialRequest, buildQueryString } from '../lib';
import type { ToolDefinition } from '@teros/mca-sdk';

export const listOvertimeRequests: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'List overtime requests with optional filters.',
  parameters: {
    type: 'object',
    properties: {
      employeeIds: { type: 'array', items: { type: 'number' }, description: 'Filter by employee IDs' },
      status: { type: 'string', description: 'Filter by status: pending, approved, rejected', enum: ['pending', 'approved', 'rejected'] },
      limit: { type: 'number', description: 'Maximum results (default: 50)' },
      offset: { type: 'number', description: 'Pagination offset' },
    },
  },
  handler: async (args, context) => {
    const qs = buildQueryString({
      employee_ids: args.employeeIds,
      status: args.status,
      limit: args.limit,
      offset: args.offset,
    });
    return factorialRequest(context, `/attendance/overtime_requests${qs}`);
  },
};
