import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminWorkspacesMembersRemove: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Remove a member from a workspace. Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string', description: 'Workspace ID' },
      userId: { type: 'string', description: 'User ID to remove' },
    },
    required: ['workspaceId', 'userId'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.workspaces-members-remove', args as Record<string, unknown>);
  },
};
