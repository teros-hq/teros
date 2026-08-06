import { factorialRequest, buildQueryString } from '../lib';
import type { ToolDefinition } from '@teros/mca-sdk';

export const listDocuments: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'List all company documents with optional filters.',
  parameters: {
    type: 'object',
    properties: {
      employeeIds: { type: 'array', items: { type: 'number' }, description: 'Filter by employee IDs' },
      folderId: { type: 'number', description: 'Filter by folder ID' },
      limit: { type: 'number', description: 'Maximum results (default: 50)' },
      offset: { type: 'number', description: 'Pagination offset' },
    },
  },
  handler: async (args, context) => {
    const qs = buildQueryString({
      employee_ids: args.employeeIds,
      folder_id: args.folderId,
      limit: args.limit,
      offset: args.offset,
    });
    return factorialRequest(context, `/documents/documents${qs}`);
  },
};
