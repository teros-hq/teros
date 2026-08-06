import type { ToolConfig } from '@teros/mca-sdk';
import { wahaFetch } from '../lib/api';

// Spec: GET /api/contacts/check-exists?phone=&session= (session as query param, not path)
export const checkNumber: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Check if a phone number has WhatsApp and get its chat ID.',
  parameters: {
    type: 'object',
    properties: {
      session: {
        type: 'string',
        description: 'Session name (default: "default")',
      },
      phone: {
        type: 'string',
        description: 'Phone number with country code (e.g. 34612345678)',
      },
    },
    required: ['phone'],
  },
  handler: async (args) => {
    const { session = 'default', phone } = args as {
      session?: string;
      phone: string;
    };
    const params = new URLSearchParams({ phone, session });
    const res = await wahaFetch(`/contacts/check-exists?${params}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, status: res.status, error: `WAHA returned HTTP ${res.status}`, detail: err };
    }
    return await res.json();
  },
};
