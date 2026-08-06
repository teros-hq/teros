import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminAgentsUpdate: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Update an existing agent. Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'Agent ID to update' },
      name: { type: 'string', description: 'New name' },
      description: { type: 'string', description: 'New description' },
      active: { type: 'boolean', description: 'Active state' },
    },
    required: ['agentId'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.agents-update', args as Record<string, unknown>);
  },
};
