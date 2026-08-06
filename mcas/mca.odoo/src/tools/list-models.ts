import { odooCallMethod } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const listModels: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'List all available Odoo models (ir.model).',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of results (default: 100)' },
      offset: { type: 'number', description: 'Pagination offset' },
    },
  },
  handler: async (args: { limit?: number; offset?: number }, context: ToolContext) => {
    return odooCallMethod(context, 'ir.model', 'search_read', [[], ['model', 'name']], {
      limit: args.limit ?? 100,
      offset: args.offset ?? 0,
      order: 'model asc',
    });
  },
};
