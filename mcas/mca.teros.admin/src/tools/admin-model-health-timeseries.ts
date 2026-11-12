import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminModelHealthTimeseries: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get per-hour health snapshots (p50/p95/p99 latency + TTFT, error rate, success rate, throughput) ' +
    'grouped by actual upstream provider × model, as a time series. Same scope as admin-model-health but ' +
    'returns one entry per time bucket instead of a merged figure. Accepts optional filters and groupBy ' +
    '(hour/day/week). Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Start of the time window (ISO 8601 date). Required.' },
      to: { type: 'string', description: 'End of the time window (ISO 8601 date). Required.' },
      userId: { type: 'string', description: 'Filter by user ID (optional).' },
      agentId: { type: 'string', description: 'Filter by agent ID (optional).' },
      workspaceId: { type: 'string', description: 'Filter by workspace ID (optional).' },
      provider: { type: 'string', description: 'Filter by logical provider name (optional).' },
      groupBy: { type: 'string', enum: ['hour', 'day', 'week'], description: 'Bucket granularity (default "hour"). Use "day" for 7d/30d ranges.' },
      timeZone: { type: 'string', description: 'Timezone label echoed in the response (default "UTC").' },
    },
    required: ['from', 'to'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.agent-usage-model-health-timeseries', args as Record<string, unknown>);
  },
};
