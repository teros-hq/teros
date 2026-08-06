import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminWorkspacesList: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'List all workspaces. Super admin only.',
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async () => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.workspaces-list');
  },
};
