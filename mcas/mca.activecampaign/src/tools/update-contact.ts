import type { ToolConfig } from '@teros/mca-sdk';
import { acRequest } from '../lib/index.js';
import { parseContact, wrap } from './_helpers.js';

interface Args {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  includeRaw?: boolean;
}

export const updateContact: ToolConfig<Args, unknown> = {
  description: 'Update a contact by id. Only provided fields are updated. Returns { contact }.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Contact id' },
      email: { type: 'string' },
      firstName: { type: 'string' },
      lastName: { type: 'string' },
      phone: { type: 'string' },
      includeRaw: { type: 'boolean' },
    },
    required: ['id'],
  },
  annotations: { readOnlyHint: false,
    version: '1.0.0',
    stability: 'stable',
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    if (!args.id?.trim()) throw new Error('id is required');
    if (args.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.email.trim())) {
      throw new Error('email must be a valid address');
    }
    const updates: Record<string, unknown> = {};
    if (args.email !== undefined) updates.email = args.email;
    if (args.firstName !== undefined) updates.firstName = args.firstName;
    if (args.lastName !== undefined) updates.lastName = args.lastName;
    if (args.phone !== undefined) updates.phone = args.phone;
    if (Object.keys(updates).length === 0) {
      throw new Error('at least one field (email, firstName, lastName, phone) must be provided');
    }

    const raw = (await acRequest(context, `/contacts/${encodeURIComponent(args.id)}`, {
      method: 'PUT',
      body: { contact: updates },
    })) as { contact?: unknown };
    return wrap({ contact: parseContact(raw.contact) }, args.includeRaw ? raw : undefined);
  },
};
