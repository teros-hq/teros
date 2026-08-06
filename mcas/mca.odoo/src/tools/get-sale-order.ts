import { odooRead } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const getSaleOrder: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'Get a specific Odoo sales order by ID, including order lines.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'number', description: 'Sales order ID' },
    },
    required: ['id'],
  },
  handler: async (args: { id: number }, context: ToolContext) => {
    return odooRead(context, 'sale.order', args.id, [
      'id',
      'name',
      'partner_id',
      'date_order',
      'amount_total',
      'state',
      'order_line',
      'user_id',
      'note',
    ]);
  },
};
