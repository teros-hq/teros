import type { ToolConfig } from '@teros/mca-sdk';
import { wahaFetch } from '../lib/api';

// Spec: PUT /api/reaction — send or remove a reaction to a message
export const reaction: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Send or remove a reaction (emoji) to a WhatsApp message.',
  parameters: {
    type: 'object',
    properties: {
      session: {
        type: 'string',
        description: 'Session name (default: "default")',
      },
      messageId: {
        type: 'string',
        description: 'ID of the message to react to',
      },
      reaction: {
        type: 'string',
        description: 'Emoji to react with (e.g. "👍"). Pass empty string "" to remove a reaction.',
      },
    },
    required: ['messageId', 'reaction'],
  },
  handler: async (args) => {
    const { session = 'default', messageId, reaction } = args as {
      session?: string;
      messageId: string;
      reaction: string;
    };
    // Spec: PUT /api/reaction with body { messageId, reaction, session }
    const res = await wahaFetch('/reaction', {
      method: 'PUT',
      body: JSON.stringify({ session, messageId, reaction }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, status: res.status, error: `WAHA returned HTTP ${res.status}`, detail: err };
    }
    if (res.status === 204) return { success: true };
    return await res.json().catch(() => ({ success: true }));
  },
};
