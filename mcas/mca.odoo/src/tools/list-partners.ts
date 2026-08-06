import { odooSearchRead, parseFilters } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const listPartners: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'List Odoo partners (contacts / companies).',
  parameters: {
    type: 'object',
    properties: {
      filters: {
        type: 'string',
        description: 'Comma-separated filters, e.g. is_company=true,name=Acme',
      },
      limit: { type: 'number', description: 'Maximum results (default: 50)' },
      offset: { type: 'number', description: 'Pagination offset' },
      order: { type: 'string', description: 'Order clause, e.g. name asc' },
    },
  },
  handler: async (
    args: { filters?: string; limit?: number; offset?: number; order?: string },
    context: ToolContext,
  ) => {
    return odooSearchRead(context, 'res.partner', {
      domain: parseFilters(args.filters),
      fields: ['id', 'name', 'email', 'phone', 'is_company', 'parent_id', 'user_id'],
      limit: args.limit,
      offset: args.offset,
      order: args.order,
    });
  },
};
