import type { ToolConfig } from '@teros/mca-sdk';
import { wahaFetch } from '../lib/api';

export const getChatLabels: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get all labels assigned to a specific WhatsApp chat. Returns an array of label objects with id, name, color, and colorHex. Only available in WhatsApp Business accounts.',
  parameters: {
    type: 'object',
    properties: {
      session: {
        type: 'string',
        description: 'Session name (default: "default")',
      },
      chatId: {
        type: 'string',
        description: 'Chat ID (e.g. 34612345678@c.us for individuals, 120363XXXXXX@g.us for groups)',
      },
    },
    required: ['chatId'],
  },
  handler: async (args) => {
    const { session = 'default', chatId } = args as {
      session?: string;
      chatId: string;
    };
    const res = await wahaFetch(`/${session}/labels/chats/${chatId}/`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, status: res.status, error: `WAHA returned HTTP ${res.status}`, detail: err };
    }
    return await res.json();
  },
};
