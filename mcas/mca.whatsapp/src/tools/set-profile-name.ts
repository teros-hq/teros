import type { ToolConfig } from '@teros/mca-sdk';
import { wahaFetch } from '../lib/api';

// Spec: PUT /api/{session}/profile/name   Body: { name: string }
export const setProfileName: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Change the display name of the current WhatsApp profile.',
  parameters: {
    type: 'object',
    properties: {
      session: {
        type: 'string',
        description: 'Session name (default: "default")',
      },
      name: {
        type: 'string',
        description: 'New display name to set',
      },
    },
    required: ['name'],
  },
  handler: async (args) => {
    const { session = 'default', name } = args as {
      session?: string;
      name: string;
    };
    const res = await wahaFetch(`/${session}/profile/name`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, status: res.status, error: `WAHA returned HTTP ${res.status}`, detail: err };
    }
    if (res.status === 204) return { success: true };
    return await res.json().catch(() => ({ success: true }));
  },
};
