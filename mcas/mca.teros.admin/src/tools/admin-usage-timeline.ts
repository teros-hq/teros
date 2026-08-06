import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminUsageTimeline: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Get usage timeline (daily/weekly aggregates). Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      granularity: { type: 'string', enum: ['day', 'week', 'month'], description: 'Time granularity' },
      startDate: { type: 'string', description: 'Start date (ISO)' },
      endDate: { type: 'string', description: 'End date (ISO)' },
    },
    required: [],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.usage-timeline', args as Record<string, unknown>);
  },
};
