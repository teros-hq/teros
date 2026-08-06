import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminAgentsGet: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Get a single agent by ID. Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'Agent ID' },
    },
    required: ['agentId'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.agents-get', { agentId: args.agentId });
  },
};
