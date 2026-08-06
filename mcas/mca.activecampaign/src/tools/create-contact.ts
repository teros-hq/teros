import type { ToolConfig } from '@teros/mca-sdk';
import { acRequest } from '../lib/index.js';
import { parseContact, wrap } from './_helpers.js';

interface Args {
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  includeRaw?: boolean;
}

export const createContact: ToolConfig<Args, unknown> = {
  description:
    'Create a contact. Email is required. Returns { contact } with the created record. ActiveCampaign upserts by email; if it exists you get the existing contact.',
  parameters: {
    type: 'object',
    properties: {
      email: { type: 'string', description: 'Contact email (required)' },
      firstName: { type: 'string' },
      lastName: { type: 'string' },
      phone: { type: 'string' },
      includeRaw: { type: 'boolean' },
    },
    required: ['email'],
  },
  annotations: { readOnlyHint: false,
    version: '1.0.0',
    stability: 'stable',
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    if (!args.email?.trim()) throw new Error('email is required');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.email.trim())) {
      throw new Error('email must be a valid address');
    }
    const body: Record<string, unknown> = { email: args.email.trim() };
    if (args.firstName) body.firstName = args.firstName;
    if (args.lastName) body.lastName = args.lastName;
    if (args.phone) body.phone = args.phone;

    const raw = (await acRequest(context, '/contact/sync', {
      method: 'POST',
      body: { contact: body },
    })) as { contact?: unknown };
    return wrap({ contact: parseContact(raw.contact) }, args.includeRaw ? raw : undefined);
  },
};
