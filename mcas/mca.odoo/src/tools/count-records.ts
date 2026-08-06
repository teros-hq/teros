import { odooSearchCount, parseFilters } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const countRecords: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'Count records in an Odoo model matching the given filters.',
  parameters: {
    type: 'object',
    properties: {
      model: { type: 'string', description: 'Odoo model technical name' },
      filters: {
        type: 'string',
        description: 'Comma-separated filters: field=value, field!=value, etc.',
      },
    },
    required: ['model'],
  },
  handler: async (
    args: { model: string; filters?: string },
    context: ToolContext,
  ) => {
    return odooSearchCount(context, args.model, parseFilters(args.filters));
  },
};
