import type { ToolConfig } from '@teros/mca-sdk';
import { acRequest } from '../lib/index.js';
import { wrap } from './_helpers.js';

interface Args {
  contactId: string;
  listId: string;
  status?: 'subscribed' | 'unsubscribed';
  includeRaw?: boolean;
}

const STATUS_MAP: Record<string, number> = { subscribed: 1, unsubscribed: 2 };

export const subscribeContactToList: ToolConfig<Args, unknown> = {
  description:
    'Subscribe (or unsubscribe) a contact to a list. Returns { contactList: {id, contact, list, status} }.',
  parameters: {
    type: 'object',
    properties: {
      contactId: { type: 'string', description: 'Contact id' },
      listId: { type: 'string', description: 'List id' },
      status: { type: 'string', enum: ['subscribed', 'unsubscribed'], description: 'Default subscribed' },
      includeRaw: { type: 'boolean' },
    },
    required: ['contactId', 'listId'],
  },
  annotations: { readOnlyHint: false,
    version: '1.0.0',
    stability: 'stable',
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    if (!args.contactId?.trim()) throw new Error('contactId is required');
    if (!args.listId?.trim()) throw new Error('listId is required');
    const numericStatus = STATUS_MAP[args.status ?? 'subscribed'];

    const raw = (await acRequest(context, '/contactLists', {
      method: 'POST',
      body: {
        contactList: {
          list: args.listId,
          contact: args.contactId,
          status: numericStatus,
        },
      },
    })) as { contactList?: Record<string, unknown> };

    const cl = raw.contactList ?? {};
    return wrap(
      {
        contactList: {
          id: String(cl.id ?? ''),
          contact: String(cl.contact ?? args.contactId),
          list: String(cl.list ?? args.listId),
          status: args.status ?? 'subscribed',
        },
      },
      args.includeRaw ? raw : undefined,
    );
  },
};
