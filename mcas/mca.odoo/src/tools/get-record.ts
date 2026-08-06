import { odooRead } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const getRecord: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'Read a single Odoo record by model and ID.',
  parameters: {
    type: 'object',
    properties: {
      model: { type: 'string', description: 'Odoo model technical name' },
      id: { type: 'number', description: 'Record ID' },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Fields to return',
      },
    },
    required: ['model', 'id'],
  },
  handler: async (
    args: { model: string; id: number; fields?: string[] },
    context: ToolContext,
  ) => {
    return odooRead(context, args.model, args.id, args.fields);
  },
};
