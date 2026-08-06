import { odooWrite } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const updatePartner: ToolDefinition = {
  annotations: { readOnlyHint: false },
  description: 'Update an existing Odoo partner by ID.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'number', description: 'Partner ID' },
      values: {
        type: 'object',
        description: 'Field values to update',
        additionalProperties: true,
      },
    },
    required: ['id', 'values'],
  },
  handler: async (
    args: { id: number; values: Record<string, unknown> },
    context: ToolContext,
  ) => {
    return odooWrite(context, 'res.partner', args.id, args.values);
  },
};
