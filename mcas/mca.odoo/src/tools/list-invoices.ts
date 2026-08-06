import { odooSearchRead, parseFilters } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const listInvoices: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'List Odoo customer invoices (account.move).',
  parameters: {
    type: 'object',
    properties: {
      filters: { type: 'string', description: 'Comma-separated filters, e.g. state=posted' },
      limit: { type: 'number', description: 'Maximum results (default: 50)' },
      offset: { type: 'number', description: 'Pagination offset' },
      order: { type: 'string', description: 'Order clause, e.g. invoice_date desc' },
    },
  },
  handler: async (
    args: { filters?: string; limit?: number; offset?: number; order?: string },
    context: ToolContext,
  ) => {
    return odooSearchRead(context, 'account.move', {
      domain: [['move_type', 'in', ['out_invoice', 'out_refund']], ...parseFilters(args.filters)],
      fields: ['id', 'name', 'partner_id', 'invoice_date', 'amount_total', 'state', 'payment_state'],
      limit: args.limit,
      offset: args.offset,
      order: args.order,
    });
  },
};
