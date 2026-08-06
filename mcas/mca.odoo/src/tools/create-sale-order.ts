import { odooCreate, odooRead } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const createSaleOrder: ToolDefinition = {
  annotations: { readOnlyHint: false },
  description: 'Create a new Odoo sales order with optional order lines.',
  parameters: {
    type: 'object',
    properties: {
      partnerId: { type: 'number', description: 'Customer partner ID' },
      orderLines: {
        type: 'array',
        description: 'Order lines as objects with productId, quantity, priceUnit',
        items: {
          type: 'object',
          properties: {
            productId: { type: 'number' },
            quantity: { type: 'number' },
            priceUnit: { type: 'number' },
          },
          required: ['productId', 'quantity'],
        },
      },
      dateOrder: { type: 'string', description: 'Order date (ISO 8601)' },
      note: { type: 'string', description: 'Internal note' },
    },
    required: ['partnerId'],
  },
  handler: async (
    args: {
      partnerId: number;
      orderLines?: Array<{ productId: number; quantity: number; priceUnit?: number }>;
      dateOrder?: string;
      note?: string;
    },
    context: ToolContext,
  ) => {
    const lines: [number, number, Record<string, unknown>][] =
      args.orderLines?.map((line) => [
        0,
        0,
        {
          product_id: line.productId,
          product_uom_qty: line.quantity,
          price_unit: line.priceUnit ?? 0,
        },
      ]) ?? [];

    const orderId = await odooCreate(context, 'sale.order', {
      partner_id: args.partnerId,
      date_order: args.dateOrder,
      order_line: lines,
      note: args.note,
    });

    return odooRead(context, 'sale.order', orderId, [
      'id',
      'name',
      'partner_id',
      'amount_total',
      'state',
    ]);
  },
};
