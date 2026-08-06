import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminAppsGetAccess: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Get agents that have access to an app. Super admin only.',
  parameters: {
    type: 'object',
    properties: { appId: { type: 'string', description: 'App ID' } },
    required: ['appId'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.apps-get-access', { appId: args.appId });
  },
};
