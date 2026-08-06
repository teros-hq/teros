import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminAgentsDelete: ToolConfig = {
  annotations: { readOnlyHint: false, irreversible: true },
  description: 'Delete an agent. Super admin only. DESTRUCTIVE — use with caution.',
  parameters: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'Agent ID to delete' },
      confirm: { type: 'boolean', description: 'Must be true to confirm deletion' },
    },
    required: ['agentId', 'confirm'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    if (!args.confirm) throw new Error('confirm must be true to delete an agent.');
    return adminRequest('admin-api.agents-delete', { agentId: args.agentId });
  },
};
