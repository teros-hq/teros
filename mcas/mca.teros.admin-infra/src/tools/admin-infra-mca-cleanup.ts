import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminInfraMcaCleanup: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Clean up stale or dead MCA processes. Super admin only. DESTRUCTIVE — use with caution.',
  parameters: {
    type: 'object',
    properties: {
      confirm: { type: 'boolean', description: 'Must be true to confirm' },
    },
    required: ['confirm'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    if (!args.confirm) throw new Error('confirm must be true to run MCA cleanup.');
    return adminRequest('admin-api.mca-cleanup');
  },
};
