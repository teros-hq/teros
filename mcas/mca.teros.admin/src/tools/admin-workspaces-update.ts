import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminWorkspacesUpdate: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Update a workspace. Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string', description: 'Workspace ID' },
      name: { type: 'string', description: 'New name' },
      description: { type: 'string', description: 'New description' },
    },
    required: ['workspaceId'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.workspaces-update', args as Record<string, unknown>);
  },
};
