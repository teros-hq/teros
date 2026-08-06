import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminAgentsCreate: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Create a new agent. Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Agent name' },
      coreId: { type: 'string', description: 'Agent core ID' },
      workspaceId: { type: 'string', description: 'Workspace ID' },
      description: { type: 'string', description: 'Optional description' },
    },
    required: ['name', 'coreId', 'workspaceId'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.agents-create', args as Record<string, unknown>);
  },
};
