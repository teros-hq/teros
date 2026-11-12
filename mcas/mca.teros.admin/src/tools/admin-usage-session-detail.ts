import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminUsageSessionDetail: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get the full detail and chronological trace of a single agent usage session: the session record, ' +
    'its LLM calls, tool executions, message text, thumbs feedback, and direct sub-agents. ' +
    'Requires a sessionUsageId. Super admin only (conversation text is super-admin-only).',
  parameters: {
    type: 'object',
    properties: {
      sessionUsageId: { type: 'string', description: 'The session usage ID of the session to inspect. Required.' },
    },
    required: ['sessionUsageId'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.agent-usage-session-detail', args as Record<string, unknown>);
  },
};
