import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminAppsList: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'List all installed apps. Super admin only.',
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async () => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.apps-list');
  },
};
