import { odooWrite } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const updateRecord: ToolDefinition = {
  annotations: { readOnlyHint: false },
  description: 'Update an existing Odoo record by model and ID.',
  parameters: {
    type: 'object',
    properties: {
      model: { type: 'string', description: 'Odoo model technical name' },
      id: { type: 'number', description: 'Record ID' },
      values: {
        type: 'object',
        description: 'Field values to update',
        additionalProperties: true,
      },
    },
    required: ['model', 'id', 'values'],
  },
  handler: async (
    args: { model: string; id: number; values: Record<string, unknown> },
    context: ToolContext,
  ) => {
    return odooWrite(context, args.model, args.id, args.values);
  },
};
