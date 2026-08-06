import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminWorkspacesArchive: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Archive (soft-delete) a workspace. Super admin only. DESTRUCTIVE — use with caution.',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string', description: 'Workspace ID' },
      confirm: { type: 'boolean', description: 'Must be true to confirm' },
    },
    required: ['workspaceId', 'confirm'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    if (!args.confirm) throw new Error('confirm must be true to archive a workspace.');
    return adminRequest('admin-api.workspaces-archive', { workspaceId: args.workspaceId });
  },
};
