import { odooSearchRead, parseFilters } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const listProducts: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'List Odoo products (product.template).',
  parameters: {
    type: 'object',
    properties: {
      filters: { type: 'string', description: 'Comma-separated filters, e.g. sale_ok=true' },
      limit: { type: 'number', description: 'Maximum results (default: 50)' },
      offset: { type: 'number', description: 'Pagination offset' },
      order: { type: 'string', description: 'Order clause, e.g. name asc' },
    },
  },
  handler: async (
    args: { filters?: string; limit?: number; offset?: number; order?: string },
    context: ToolContext,
  ) => {
    return odooSearchRead(context, 'product.template', {
      domain: parseFilters(args.filters),
      fields: ['id', 'name', 'default_code', 'list_price', 'standard_price', 'qty_available', 'sale_ok'],
      limit: args.limit,
      offset: args.offset,
      order: args.order,
    });
  },
};
