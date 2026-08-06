import type { ToolConfig } from '@teros/mca-sdk';
import { wahaFetch } from '../lib/api';

export const sessionStatus: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get the status of a WhatsApp session. Status can be: WORKING, SCAN_QR_CODE, STARTING, STOPPED, FAILED. SCAN_QR_CODE means the session is waiting to be linked — use request-pairing-code (authentication is always done with a pairing code, never QR).',
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
    const res = await wahaFetch(`/sessions/${session}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, status: res.status, error: `WAHA returned HTTP ${res.status}`, detail: err };
    }
    return await res.json();
  },
};
