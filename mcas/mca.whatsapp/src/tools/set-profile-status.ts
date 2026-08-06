import type { ToolConfig } from '@teros/mca-sdk';
import { wahaFetch } from '../lib/api';

// Spec: PUT /api/{session}/profile/status   Body: { status: string }
export const setProfileStatus: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Change the "About" status text of the current WhatsApp profile.',
  parameters: {
    type: 'object',
    properties: {
      session: {
        type: 'string',
        description: 'Session name (default: "default")',
      },
      status: {
        type: 'string',
        description: 'New About/status text to set',
      },
    },
    required: ['status'],
  },
  handler: async (args) => {
    const { session = 'default', status } = args as {
      session?: string;
      status: string;
    };
    const res = await wahaFetch(`/${session}/profile/status`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, status: res.status, error: `WAHA returned HTTP ${res.status}`, detail: err };
    }
    if (res.status === 204) return { success: true };
    return await res.json().catch(() => ({ success: true }));
  },
};
