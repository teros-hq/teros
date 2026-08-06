import { odooSearchRead, parseFilters } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const searchRecords: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description:
    'Search and read records from any Odoo model. Use filters like "is_company=true,name=Acme".',
  parameters: {
    type: 'object',
    properties: {
      model: { type: 'string', description: 'Odoo model technical name, e.g. res.partner' },
      filters: {
        type: 'string',
        description: 'Comma-separated filters: field=value, field!=value, field>value, etc.',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Fields to return (default: all stored fields)',
      },
      limit: { type: 'number', description: 'Maximum results (default: 50)' },
      offset: { type: 'number', description: 'Pagination offset' },
      order: { type: 'string', description: 'Order clause, e.g. name asc' },
    },
    required: ['model'],
  },
  handler: async (
    args: {
      model: string;
      filters?: string;
      fields?: string[];
      limit?: number;
      offset?: number;
      order?: string;
    },
    context: ToolContext,
  ) => {
    return odooSearchRead(context, args.model, {
      domain: parseFilters(args.filters),
      fields: args.fields,
      limit: args.limit,
      offset: args.offset,
      order: args.order,
    });
  },
};
