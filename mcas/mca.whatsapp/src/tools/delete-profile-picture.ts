import type { ToolConfig } from '@teros/mca-sdk';
import { wahaFetch } from '../lib/api';

// Spec: DELETE /api/{session}/profile/picture
export const deleteProfilePicture: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Delete the profile picture of the current WhatsApp account.',
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
    const res = await wahaFetch(`/${session}/profile/picture`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, status: res.status, error: `WAHA returned HTTP ${res.status}`, detail: err };
    }
    if (res.status === 204) return { success: true };
    return await res.json().catch(() => ({ success: true }));
  },
};
