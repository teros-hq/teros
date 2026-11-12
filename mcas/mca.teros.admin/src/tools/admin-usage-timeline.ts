import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminUsageTimeline: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Get usage timeline (daily/weekly aggregates). Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      granularity: { type: 'string', enum: ['hour', 'day', 'week', 'month'], description: 'Time granularity for aggregation (default: day)' },
      startDate: { type: 'string', description: 'Start date (ISO 8601). If omitted, returns all available data from the earliest rollup.' },
      endDate: { type: 'string', description: 'End date (ISO 8601). If omitted, no upper bound.' },
    },
    required: [],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.usage-timeline', args as Record<string, unknown>);
  },
};
