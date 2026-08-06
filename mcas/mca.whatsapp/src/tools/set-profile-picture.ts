import type { ToolConfig } from '@teros/mca-sdk';
import { wahaFetch } from '../lib/api';

// Spec: PUT /api/{session}/profile/picture   Body: { file: { url: string } }
export const setProfilePicture: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Set the profile picture of the current WhatsApp account from a public image URL.',
  parameters: {
    type: 'object',
    properties: {
      session: {
        type: 'string',
        description: 'Session name (default: "default")',
      },
      url: {
        type: 'string',
        description: 'Public HTTPS URL of the image to use as profile picture',
      },
    },
    required: ['url'],
  },
  handler: async (args) => {
    const { session = 'default', url } = args as {
      session?: string;
      url: string;
    };
    const res = await wahaFetch(`/${session}/profile/picture`, {
      method: 'PUT',
      body: JSON.stringify({ file: { url } }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, status: res.status, error: `WAHA returned HTTP ${res.status}`, detail: err };
    }
    if (res.status === 204) return { success: true };
    return await res.json().catch(() => ({ success: true }));
  },
};
