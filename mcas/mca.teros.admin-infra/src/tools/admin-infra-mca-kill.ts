import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminInfraMcaKill: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Kill a running MCA process by ID. Super admin only. DESTRUCTIVE — use with caution.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'MCA process ID to kill' },
      confirm: { type: 'boolean', description: 'Must be true to confirm' },
    },
    required: ['id', 'confirm'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    if (!args.confirm) throw new Error('confirm must be true to kill an MCA process.');
    return adminRequest('admin-api.mca-kill', { id: args.id });
  },
};
