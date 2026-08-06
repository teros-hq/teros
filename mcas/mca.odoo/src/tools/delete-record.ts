import { odooUnlink } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const deleteRecord: ToolDefinition = {
  annotations: { readOnlyHint: false },
  description: 'Delete an Odoo record by model and ID.',
  parameters: {
    type: 'object',
    properties: {
      model: { type: 'string', description: 'Odoo model technical name' },
      id: { type: 'number', description: 'Record ID' },
    },
    required: ['model', 'id'],
  },
  handler: async (args: { model: string; id: number }, context: ToolContext) => {
    return odooUnlink(context, args.model, args.id);
  },
};
