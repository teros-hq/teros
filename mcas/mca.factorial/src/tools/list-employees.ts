import { factorialRequest, buildQueryString } from '../lib';
import type { ToolDefinition } from '@teros/mca-sdk';

export const listEmployees: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'List all employees in the company with optional filters.',
  parameters: {
    type: 'object',
    properties: {
      active: { type: 'boolean', description: 'Filter by active status' },
      teamIds: { type: 'array', items: { type: 'number' }, description: 'Filter by team IDs' },
      locationIds: { type: 'array', items: { type: 'number' }, description: 'Filter by location IDs' },
      limit: { type: 'number', description: 'Maximum results (default: 50)' },
      offset: { type: 'number', description: 'Pagination offset' },
    },
  },
  handler: async (args, context) => {
    const qs = buildQueryString({
      active: args.active,
      team_ids: args.teamIds,
      location_ids: args.locationIds,
      limit: args.limit,
      offset: args.offset,
    });
    return factorialRequest(context, `/employees/employees${qs}`);
  },
};
