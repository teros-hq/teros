import type { ToolConfig } from '@teros/mca-sdk';
import { acRequest } from '../lib/index.js';
import { buildPaginated, parseContact, wrap } from './_helpers.js';

interface Args {
  email?: string;
  search?: string;
  listId?: string;
  limit?: number;
  offset?: number;
  includeRaw?: boolean;
}

export const listContacts: ToolConfig<Args, unknown> = {
  description:
    'List contacts. Returns { items[{id,email,firstName,lastName,phone}], total, nextOffset }. Filter by email, free-text search, or listId.',
  parameters: {
    type: 'object',
    properties: {
      email: { type: 'string', description: 'Exact email match' },
      search: { type: 'string', description: 'Free-text search (name/email)' },
      listId: { type: 'string', description: 'Only contacts subscribed to this list' },
      limit: { type: 'number', description: 'Max results (default 20, max 100)' },
      offset: { type: 'number', description: 'Pagination offset (default 0)' },
      includeRaw: { type: 'boolean', description: 'Include raw API response' },
    },
  },
  annotations: {
    version: '1.0.0',
    stability: 'stable',
    readOnlyHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
    const offset = Math.max(args.offset ?? 0, 0);
    const raw = (await acRequest(context, '/contacts', {
      searchParams: {
        email: args.email,
        search: args.search,
        listid: args.listId,
        limit,
        offset,
      },
    })) as { contacts?: unknown[]; meta?: unknown };

    const items = (raw.contacts ?? []).map(parseContact);
    const data = buildPaginated(items, raw.meta, offset, limit);
    return wrap({ contacts: data.items, total: data.total, nextOffset: data.nextOffset }, args.includeRaw ? raw : undefined);
  },
};
