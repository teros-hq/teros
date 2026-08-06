import type { ToolConfig } from '@teros/mca-sdk';
import { acRequest } from '../lib/index.js';
import { wrap } from './_helpers.js';

interface Args {
  contactId: string;
  tagId: string;
  includeRaw?: boolean;
}

export const addTagToContact: ToolConfig<Args, unknown> = {
  description: 'Assign a tag to a contact. Returns { contactTag: {id, contact, tag} }.',
  parameters: {
    type: 'object',
    properties: {
      contactId: { type: 'string' },
      tagId: { type: 'string' },
      includeRaw: { type: 'boolean' },
    },
    required: ['contactId', 'tagId'],
  },
  annotations: { readOnlyHint: false,
    version: '1.0.0',
    stability: 'stable',
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    if (!args.contactId?.trim()) throw new Error('contactId is required');
    if (!args.tagId?.trim()) throw new Error('tagId is required');

    const raw = (await acRequest(context, '/contactTags', {
      method: 'POST',
      body: { contactTag: { contact: args.contactId, tag: args.tagId } },
    })) as { contactTag?: Record<string, unknown> };

    const ct = raw.contactTag ?? {};
    return wrap(
      {
        contactTag: {
          id: String(ct.id ?? ''),
          contact: String(ct.contact ?? args.contactId),
          tag: String(ct.tag ?? args.tagId),
        },
      },
      args.includeRaw ? raw : undefined,
    );
  },
};
