import type { ToolConfig } from '@teros/mca-sdk';
import { acRequest } from '../lib/index.js';
import { parseContact, wrap } from './_helpers.js';

interface Args {
  id: string;
  includeRaw?: boolean;
}

export const getContact: ToolConfig<Args, unknown> = {
  description: 'Get a contact by id. Returns { contact: {id,email,firstName,lastName,phone,cdate,udate} }.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Contact id' },
      includeRaw: { type: 'boolean' },
    },
    required: ['id'],
  },
  annotations: {
    version: '1.0.0',
    stability: 'stable',
    readOnlyHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    if (!args.id?.trim()) throw new Error('id is required');
    const raw = (await acRequest(context, `/contacts/${encodeURIComponent(args.id)}`)) as {
      contact?: unknown;
    };
    return wrap({ contact: parseContact(raw.contact) }, args.includeRaw ? raw : undefined);
  },
};
