import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminAccessList: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'List all agent-app access grants. Super admin only.',
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async () => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.access-list');
  },
};
