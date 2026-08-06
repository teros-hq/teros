import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminAccessRevoke: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Revoke an agent access to an app. Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'Agent ID' },
      appId: { type: 'string', description: 'App ID' },
    },
    required: ['agentId', 'appId'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.access-revoke', args as Record<string, unknown>);
  },
};
