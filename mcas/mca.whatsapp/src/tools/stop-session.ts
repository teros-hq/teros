import type { ToolConfig } from '@teros/mca-sdk';
import { wahaFetch } from '../lib/api';

export const stopSession: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Stop a WhatsApp session without deleting it. The session can be restarted later with start-session.',
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
    const res = await wahaFetch(`/sessions/${session}/stop`, {
      method: 'POST',
    });
    if (res.status === 200 || res.status === 204) return { success: true, session };
    const data = await res.json().catch(() => ({}));
    return { success: false, status: res.status, ...data };
  },
};
