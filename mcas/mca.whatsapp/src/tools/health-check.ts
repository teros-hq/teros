import type { ToolConfig } from '@teros/mca-sdk';
import { WAHA_BASE, wahaFetch } from '../lib/api';

export const healthCheck: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Internal health check tool. Verifies WAHA connectivity and lists active sessions.',
  parameters: { type: 'object', properties: {} },
  handler: async () => {
    const res = await wahaFetch('/sessions');
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, status: res.status, error: `WAHA returned HTTP ${res.status}`, detail: err };
    }
    const sessions = await res.json();
    return { status: 'ok', waha_url: WAHA_BASE, sessions };
  },
};
