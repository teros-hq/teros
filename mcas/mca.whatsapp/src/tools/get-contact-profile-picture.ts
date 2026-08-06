import type { ToolConfig } from '@teros/mca-sdk';
import { wahaFetch } from '../lib/api';

// Spec: GET /api/contacts/profile-picture?contactId=&session=&refresh=
export const getContactProfilePicture: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: "Get the profile picture URL of a WhatsApp contact.",
  parameters: {
    type: 'object',
    properties: {
      session: {
        type: 'string',
        description: 'Session name (default: "default")',
      },
      contactId: {
        type: 'string',
        description: 'Contact chat ID (e.g. 34612345678@c.us)',
      },
      refresh: {
        type: 'boolean',
        description: 'Force a refresh of the cached picture (optional)',
      },
    },
    required: ['contactId'],
  },
  handler: async (args) => {
    const { session = 'default', contactId, refresh } = args as {
      session?: string;
      contactId: string;
      refresh?: boolean;
    };
    const params = new URLSearchParams({ contactId, session });
    if (refresh !== undefined) params.set('refresh', String(refresh));
    const res = await wahaFetch(`/contacts/profile-picture?${params}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, status: res.status, error: `WAHA returned HTTP ${res.status}`, detail: err };
    }
    return await res.json();
  },
};
