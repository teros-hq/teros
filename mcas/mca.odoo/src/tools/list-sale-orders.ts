import { odooSearchRead, parseFilters } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const listSaleOrders: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'List Odoo sales orders.',
  parameters: {
    type: 'object',
    properties: {
      filters: { type: 'string', description: 'Comma-separated filters, e.g. state=sale' },
      limit: { type: 'number', description: 'Maximum results (default: 50)' },
      offset: { type: 'number', description: 'Pagination offset' },
      order: { type: 'string', description: 'Order clause, e.g. date_order desc' },
    },
  },
  handler: async (
    args: { filters?: string; limit?: number; offset?: number; order?: string },
    context: ToolContext,
  ) => {
    return odooSearchRead(context, 'sale.order', {
      domain: parseFilters(args.filters),
      fields: ['id', 'name', 'partner_id', 'date_order', 'amount_total', 'state', 'user_id'],
      limit: args.limit,
      offset: args.offset,
      order: args.order,
    });
  },
};
