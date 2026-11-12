import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminActiveSessions: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List active WebSocket connections in real time: total connections, unique users, and per-session detail (userName, userEmail, connectedAt, lastActivityAt, idleSeconds, connectionDurationSeconds). Admin only.',
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async () => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.system-active-sessions');
  },
};
