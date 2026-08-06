import type { ToolConfig } from '@teros/mca-sdk';
import { wahaFetch } from '../lib/api';

// Spec: GET /api/{session}/profile
export const getProfile: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get the profile of the current WhatsApp account (name, picture URL, status/About text, etc.).',
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
    const res = await wahaFetch(`/${session}/profile`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, status: res.status, error: `WAHA returned HTTP ${res.status}`, detail: err };
    }
    return await res.json();
  },
};
