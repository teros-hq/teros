import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminAppsDelete: ToolConfig = {
  annotations: { readOnlyHint: false, irreversible: true },
  description: 'Delete an installed app. Super admin only. DESTRUCTIVE — use with caution.',
  parameters: {
    type: 'object',
    properties: {
      appId: { type: 'string', description: 'App ID to delete' },
      confirm: { type: 'boolean', description: 'Must be true to confirm' },
    },
    required: ['appId', 'confirm'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    if (!args.confirm) throw new Error('confirm must be true to delete an app.');
    return adminRequest('admin-api.apps-delete', { appId: args.appId });
  },
};
