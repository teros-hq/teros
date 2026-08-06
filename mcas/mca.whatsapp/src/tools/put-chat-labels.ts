import type { ToolConfig } from '@teros/mca-sdk';
import { wahaFetch } from '../lib/api';

export const putChatLabels: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Set (replace) the labels assigned to a WhatsApp chat. You must provide the FULL list of labels to assign — any labels not included will be removed. Pass an empty array to remove all labels. Only available in WhatsApp Business accounts.',
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
      labels: {
        type: 'array',
        description: 'Full list of labels to assign to the chat. Each item must have an "id" field (e.g. [{ "id": "1" }, { "id": "2" }]). Pass an empty array [] to remove all labels.',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Label ID',
            },
          },
          required: ['id'],
        },
      },
    },
    required: ['chatId', 'labels'],
  },
  handler: async (args) => {
    const { session = 'default', chatId, labels } = args as {
      session?: string;
      chatId: string;
      labels: Array<{ id: string }>;
    };
    const res = await wahaFetch(`/${session}/labels/chats/${chatId}/`, {
      method: 'PUT',
      body: JSON.stringify({ labels }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, status: res.status, error: `WAHA returned HTTP ${res.status}`, detail: err };
    }
    return await res.json();
  },
};
