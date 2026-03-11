import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { intercomRequest } from '../lib';

export const searchContacts: ToolConfig = {
  description: 'Search Intercom contacts by email, name, or phone number.',
  parameters: {
    type: 'object',
    properties: {
      email: {
        type: 'string',
        description: 'Filter by exact email address',
      },
      name: {
        type: 'string',
        description: 'Filter by name (partial match)',
      },
      phone: {
        type: 'string',
        description: 'Filter by phone number',
      },
      perPage: {
        type: 'number',
        description: 'Results per page (default: 20, max: 50)',
      },
    },
  },
  handler: async (args, context) => {
    const { email, name, phone, perPage = 20 } = args as {
      email?: string;
      name?: string;
      phone?: string;
      perPage?: number;
    };

    const conditions: unknown[] = [];
    if (email) conditions.push({ field: 'email', operator: '=', value: email });
    if (name) conditions.push({ field: 'name', operator: '~', value: name });
    if (phone) conditions.push({ field: 'phone', operator: '=', value: phone });

    const query =
      conditions.length === 1
        ? conditions[0]
        : conditions.length > 1
          ? { operator: 'AND', value: conditions }
          : { field: 'email', operator: '!=', value: '' }; // fallback: all contacts

    const result = (await intercomRequest(context, '/contacts/search', {
      method: 'POST',
      body: { query, pagination: { per_page: Math.min(perPage, 50) } },
    })) as Record<string, unknown>;

    const contacts = (result.data as any[]) ?? [];
    return {
      totalCount: (result.pages as any)?.total_count,
      count: contacts.length,
      contacts: contacts.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        phone: c.phone,
        createdAt: c.created_at,
        lastSeenAt: c.last_seen_at,
      })),
    };
  },
};
