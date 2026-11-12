import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminInfraMcaKill: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Kill a running MCA process by appId. Super admin only. DESTRUCTIVE — use with caution.',
  parameters: {
    type: 'object',
    properties: {
      appId: {
        type: 'string',
        description: "The appId of the MCA process to kill (e.g., 'app_51a87881c58035ce', from admin-infra-mca-status)",
      },
      confirm: { type: 'boolean', description: 'Must be true to confirm' },
    },
    required: ['appId', 'confirm'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    if (!args.confirm) throw new Error('confirm must be true to kill an MCA process.');
    if (!args.appId) throw new Error('appId is required');
    // Backend handler (admin-api.mca-kill) reads rawData.appId — matches McaManager.kill(appId).
    return adminRequest('admin-api.mca-kill', { appId: args.appId });
  },
};
