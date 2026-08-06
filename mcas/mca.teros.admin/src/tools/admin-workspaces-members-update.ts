import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminWorkspacesMembersUpdate: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Update a workspace member role. Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string', description: 'Workspace ID' },
      userId: { type: 'string', description: 'User ID' },
      role: { type: 'string', description: 'New role' },
    },
    required: ['workspaceId', 'userId', 'role'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.workspaces-members-update', args as Record<string, unknown>);
  },
};
