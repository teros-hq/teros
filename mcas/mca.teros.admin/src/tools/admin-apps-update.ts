import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminAppsUpdate: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Update an installed app. Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      appId: { type: 'string', description: 'App ID' },
      name: { type: 'string', description: 'New name' },
      config: { type: 'object', description: 'Updated configuration' },
      active: { type: 'boolean', description: 'Active state' },
    },
    required: ['appId'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.apps-update', args as Record<string, unknown>);
  },
};
