import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminAppsCreate: ToolConfig = {
  annotations: { readOnlyHint: false, alwaysAsk: true },
  description: 'Install/create an app instance. Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      mcaId: { type: 'string', description: 'MCA ID to install' },
      ownerId: { type: 'string', description: 'Owner user ID' },
      name: { type: 'string', description: 'App instance name' },
      config: { type: 'object', description: 'App configuration' },
    },
    required: ['mcaId', 'ownerId'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.apps-create', args as Record<string, unknown>);
  },
};
