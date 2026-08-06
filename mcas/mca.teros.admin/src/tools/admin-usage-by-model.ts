import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminUsageByModel: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Get usage breakdown by LLM model. Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Max results' },
      startDate: { type: 'string', description: 'Start date (ISO)' },
      endDate: { type: 'string', description: 'End date (ISO)' },
    },
    required: [],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.usage-by-model', args as Record<string, unknown>);
  },
};
