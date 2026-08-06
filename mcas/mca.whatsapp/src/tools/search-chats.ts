import type { ToolConfig } from '@teros/mca-sdk';
import { wahaFetch } from '../lib/api';

export const searchChats: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Search WhatsApp chats by name or phone number. Filters client-side over the full chat list.',
  parameters: {
    type: 'object',
    properties: {
      session: {
        type: 'string',
        description: 'Session name (default: "default")',
      },
      query: {
        type: 'string',
        description: 'Text to search in chat name or chat ID (case-insensitive)',
      },
      limit: {
        type: 'number',
        description: 'Max chats to fetch before filtering (default: 200)',
      },
    },
    required: ['query'],
  },
  handler: async (args) => {
    const { session = 'default', query, limit = 200 } = args as {
      session?: string;
      query: string;
      limit?: number;
    };
    const params = new URLSearchParams({ limit: String(limit) });
    const res = await wahaFetch(`/${session}/chats?${params}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, status: res.status, ...err };
    }
    const chats: Array<{ id?: string; name?: string; [key: string]: unknown }> = await res.json();
    const q = query.toLowerCase();
    const matches = chats.filter((chat) => {
      const id = (chat.id ?? '').toLowerCase();
      const name = (chat.name ?? '').toLowerCase();
      return id.includes(q) || name.includes(q);
    });
    return { query, total: chats.length, matches };
  },
};
