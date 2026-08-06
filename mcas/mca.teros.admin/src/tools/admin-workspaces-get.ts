import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminWorkspacesGet: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Get a workspace by ID. Super admin only.',
  parameters: {
    type: 'object',
    properties: { workspaceId: { type: 'string', description: 'Workspace ID' } },
    required: ['workspaceId'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.workspaces-get', { workspaceId: args.workspaceId });
  },
};
