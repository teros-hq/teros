import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminUsageSessions: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List agent usage sessions (paginated, newest first). Each session represents one LLM turn. ' +
    'Accepts filters (userId, agentId, workspaceId, provider, triggerKind, statuses) and pagination ' +
    '(limit, skip). Use format="otel" for OpenTelemetry-style output. Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Start of the time window (ISO 8601 date). Required.' },
      to: { type: 'string', description: 'End of the time window (ISO 8601 date). Required.' },
      userId: { type: 'string', description: 'Filter by user ID (optional).' },
      agentId: { type: 'string', description: 'Filter by agent ID (optional).' },
      workspaceId: { type: 'string', description: 'Filter by workspace ID (optional).' },
      provider: { type: 'string', description: 'Filter by logical provider name (optional).' },
      triggerKind: { type: 'string', description: 'Filter by trigger kind (optional, e.g. "user_message", "scheduled").' },
      statuses: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter by session status (optional, e.g. ["completed", "errored", "running"]).',
      },
      format: { type: 'string', enum: ['native', 'otel'], description: 'Output format (default "native").' },
      limit: { type: 'number', description: 'Max results (default 50, max 500).' },
      skip: { type: 'number', description: 'Number of results to skip for pagination (default 0).' },
    },
    required: ['from', 'to'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.agent-usage-list-sessions', args as Record<string, unknown>);
  },
};
