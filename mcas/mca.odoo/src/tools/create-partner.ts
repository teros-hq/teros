import { odooCreate } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const createPartner: ToolDefinition = {
  annotations: { readOnlyHint: false },
  description: 'Create a new Odoo partner (contact or company).',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Partner name' },
      email: { type: 'string', description: 'Email address' },
      phone: { type: 'string', description: 'Phone number' },
      isCompany: { type: 'boolean', description: 'Whether this is a company' },
      street: { type: 'string', description: 'Street address' },
      city: { type: 'string', description: 'City' },
      zip: { type: 'string', description: 'ZIP / postal code' },
      countryId: { type: 'number', description: 'Country ID' },
      parentId: { type: 'number', description: 'Parent company ID' },
      values: {
        type: 'object',
        description: 'Additional field values',
        additionalProperties: true,
      },
    },
    required: ['name'],
  },
  handler: async (
    args: {
      name: string;
      email?: string;
      phone?: string;
      isCompany?: boolean;
      street?: string;
      city?: string;
      zip?: string;
      countryId?: number;
      parentId?: number;
      values?: Record<string, unknown>;
    },
    context: ToolContext,
  ) => {
    const values: Record<string, unknown> = {
      name: args.name,
      email: args.email,
      phone: args.phone,
      is_company: args.isCompany ?? false,
      street: args.street,
      city: args.city,
      zip: args.zip,
      country_id: args.countryId,
      parent_id: args.parentId,
      ...(args.values ?? {}),
    };
    return odooCreate(context, 'res.partner', values);
  },
};
