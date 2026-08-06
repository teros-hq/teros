import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminAppsSetPermissions: ToolConfig = {
  annotations: { readOnlyHint: false, alwaysAsk: true },
  description: 'Set permissions for an app (which agents can use it). Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      appId: { type: 'string', description: 'App ID' },
      agentIds: { type: 'array', items: { type: 'string' }, description: 'List of agent IDs allowed to use this app' },
    },
    required: ['appId', 'agentIds'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.apps-set-permissions', args as Record<string, unknown>);
  },
};
