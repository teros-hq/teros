import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminInFlight: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get a live snapshot of LLM streams currently in flight, per real upstream provider. ' +
    'Reads from the in-memory process gauge (not the database), so it is a point-in-time reading ' +
    'of this backend instance. Returns per-upstream counts, total, and a capturedAt timestamp. ' +
    'Super admin only.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.agent-usage-in-flight', {});
  },
};
