import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminModelHealth: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get per-model LLM health metrics (p50/p95/p99 latency + TTFT, error rate by kind, success rate, throughput) ' +
    'grouped by actual upstream provider × model. Accepts optional filters (userId, agentId, workspaceId, provider) ' +
    'and a time range (from/to as ISO dates). Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Start of the time window (ISO 8601 date, e.g. 2026-09-14T00:00:00Z). Required.' },
      to: { type: 'string', description: 'End of the time window (ISO 8601 date, e.g. 2026-09-15T00:00:00Z). Required.' },
      userId: { type: 'string', description: 'Filter by user ID (optional).' },
      agentId: { type: 'string', description: 'Filter by agent ID (optional).' },
      workspaceId: { type: 'string', description: 'Filter by workspace ID (optional).' },
      provider: { type: 'string', description: 'Filter by logical provider name (optional, e.g. "fireworks", "openai").' },
      timeZone: { type: 'string', description: 'Timezone label echoed in the response for client-side rendering (default "UTC").' },
    },
    required: ['from', 'to'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.agent-usage-model-health', args as Record<string, unknown>);
  },
};
