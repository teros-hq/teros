import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminWorkspacesCreate: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Create a new workspace. Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Workspace name' },
      description: { type: 'string', description: 'Optional description' },
    },
    required: ['name'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.workspaces-create', args as Record<string, unknown>);
  },
};
