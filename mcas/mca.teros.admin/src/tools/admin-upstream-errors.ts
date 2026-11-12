import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminUpstreamErrors: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get the most recent upstream provider errors (rate_limited, overloaded, server_error, spend_gate, ' +
    'auth_error, model_unavailable). Returns the error kind, sub-reason, and PII-scrubbed upstream message ' +
    'per session. Accepts optional filters (userId, agentId, workspaceId, provider) and a time range (from/to). ' +
    'Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Start of the time window (ISO 8601 date). Required.' },
      to: { type: 'string', description: 'End of the time window (ISO 8601 date). Required.' },
      userId: { type: 'string', description: 'Filter by user ID (optional).' },
      agentId: { type: 'string', description: 'Filter by agent ID (optional).' },
      workspaceId: { type: 'string', description: 'Filter by workspace ID (optional).' },
      provider: { type: 'string', description: 'Filter by logical provider name (optional).' },
      limit: { type: 'number', description: 'Max results (default 50, max 200).' },
    },
    required: ['from', 'to'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.agent-usage-upstream-errors', args as Record<string, unknown>);
  },
};
