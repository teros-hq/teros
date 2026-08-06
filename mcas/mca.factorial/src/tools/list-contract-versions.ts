import { factorialRequest, buildQueryString } from '../lib';
import type { ToolDefinition } from '@teros/mca-sdk';

export const listContractVersions: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'List all employee contract versions.',
  parameters: {
    type: 'object',
    properties: {
      employeeIds: { type: 'array', items: { type: 'number' }, description: 'Filter by employee IDs' },
      limit: { type: 'number', description: 'Maximum results (default: 50)' },
      offset: { type: 'number', description: 'Pagination offset' },
    },
  },
  handler: async (args, context) => {
    const qs = buildQueryString({
      employee_ids: args.employeeIds,
      limit: args.limit,
      offset: args.offset,
    });
    return factorialRequest(context, `/contracts/contract_versions${qs}`);
  },
};
