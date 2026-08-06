import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminWorkspacesMembersAdd: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Add a member to a workspace. Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string', description: 'Workspace ID' },
      userId: { type: 'string', description: 'User ID to add' },
      role: { type: 'string', description: 'Role (e.g. member, admin)' },
    },
    required: ['workspaceId', 'userId', 'role'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.workspaces-members-add', args as Record<string, unknown>);
  },
};
