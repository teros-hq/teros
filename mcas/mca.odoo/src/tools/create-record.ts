import { odooCreate } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const createRecord: ToolDefinition = {
  annotations: { readOnlyHint: false },
  description: 'Create a new record in any Odoo model.',
  parameters: {
    type: 'object',
    properties: {
      model: { type: 'string', description: 'Odoo model technical name' },
      values: {
        type: 'object',
        description: 'Field values for the new record',
        additionalProperties: true,
      },
    },
    required: ['model', 'values'],
  },
  handler: async (
    args: { model: string; values: Record<string, unknown> },
    context: ToolContext,
  ) => {
    return odooCreate(context, args.model, args.values);
  },
};
