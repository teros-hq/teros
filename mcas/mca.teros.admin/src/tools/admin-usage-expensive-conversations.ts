import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminUsageExpensiveConversations: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'List most expensive conversations by cost. Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Max results (default 50)' },
      startDate: { type: 'string', description: 'Start date (ISO)' },
      endDate: { type: 'string', description: 'End date (ISO)' },
    },
    required: [],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.usage-expensive-conversations', args as Record<string, unknown>);
  },
};
