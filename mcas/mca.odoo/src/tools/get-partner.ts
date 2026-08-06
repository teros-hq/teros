import { odooRead } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const getPartner: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'Get a specific Odoo partner by ID.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'number', description: 'Partner ID' },
    },
    required: ['id'],
  },
  handler: async (args: { id: number }, context: ToolContext) => {
    return odooRead(context, 'res.partner', args.id, [
      'id',
      'name',
      'email',
      'phone',
      'mobile',
      'street',
      'city',
      'zip',
      'country_id',
      'is_company',
      'parent_id',
      'user_id',
    ]);
  },
};
