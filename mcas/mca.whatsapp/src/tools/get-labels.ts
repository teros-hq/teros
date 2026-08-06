import type { ToolConfig } from '@teros/mca-sdk';
import { wahaFetch } from '../lib/api';

export const getLabels: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List all labels available in a WhatsApp Business session. Labels are used to organize chats. Only available in WhatsApp Business accounts.',
  parameters: {
    type: 'object',
    properties: {
      session: {
        type: 'string',
        description: 'Session name (default: "default")',
      },
    },
  },
  handler: async (args) => {
    const { session = 'default' } = args as { session?: string };
    const res = await wahaFetch(`/${session}/labels`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, status: res.status, error: `WAHA returned HTTP ${res.status}`, detail: err };
    }
    return await res.json();
  },
};
