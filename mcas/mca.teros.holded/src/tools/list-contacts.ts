import { holdedRequest } from '../lib/index.js';
import type { ToolDefinition } from '@teros/mca-sdk';

export const listContacts: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description:
    'List contacts from Holded invoicing module. Returns a curated list of contacts with id, name, email, phone, and other key fields. Supports pagination via page and limit.',
  parameters: {
    type: 'object',
    properties: {
      page: {
        type: 'number',
        description: 'Page number for pagination (default: 1)',
        default: 1,
      },
      limit: {
        type: 'number',
        description: 'Number of results per page (default: 25, max: 100)',
        default: 25,
      },
      type: {
        type: 'string',
        description: 'Filter by contact type (e.g. client, supplier, lead)',
      },
    },
  },
  handler: async (args, context) => {
    const { page = 1, limit = 25, type } = args as {
      page?: number;
      limit?: number;
      type?: string;
    };

    const params: Record<string, string | number> = { page, limit };
    if (type) params.type = type;

    const data = (await holdedRequest(context, '/invoicing/v1/contacts', {
      params,
    })) as any[];

    const contacts = Array.isArray(data)
      ? data.map((c) => ({
          id: c.id ?? null,
          name: c.name ?? null,
          email: c.email ?? null,
          phone: c.phone ?? null,
          mobile: c.mobile ?? null,
          type: c.type ?? null,
          code: c.code ?? null,
          tradeName: c.tradeName ?? null,
          address: c.address ?? null,
          city: c.city ?? null,
          zip: c.zip ?? null,
          country: c.country ?? null,
          vatNumber: c.vatNumber ?? null,
          createdAt: c.createdAt ?? null,
          updatedAt: c.updatedAt ?? null,
        }))
      : [];

    return {
      contacts,
      count: contacts.length,
      page,
      limit,
    };
  },
};
