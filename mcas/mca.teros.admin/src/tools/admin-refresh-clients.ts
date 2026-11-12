import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

/**
 * admin-refresh-clients — "Reiniciar todos los browsers".
 *
 * Broadcasts a refresh signal over WebSocket to every connected client (all
 * devices of all users), or — with userId — only to one user's sessions.
 * Clients reload gracefully with random jitter within maxDelayMs (default
 * 30s) so a deploy-finished broadcast doesn't hammer nginx/backend.
 *
 * Deploy pipelines should use the HTTP webhook instead
 * (POST /admin/refresh-clients with the admin API key) — this tool is the
 * admin-panel / agent-driven entry point.
 */
export const adminRefreshClients: ToolConfig = {
  description:
    'Restart all connected browsers: broadcast a refresh signal to every connected client (all users, all devices) so they reload to the latest deployed version. Clients reload with random staggered delay (default 0-30s jitter) to avoid overloading the backend. Optional params: userId (string, refresh only that user\'s sessions), reason (string, e.g. "deploy" — shown in client logs), maxDelayMs (number, stagger window, default 30000, max 300000). Returns how many sessions received the signal (sent, totalConnections, uniqueUsers). Admin only.',
  parameters: {
    type: 'object',
    properties: {
      userId: {
        type: 'string',
        description: 'Optional: refresh only this user\'s sessions (all their devices). Omit to refresh everyone.',
      },
      reason: {
        type: 'string',
        description: 'Why the refresh is happening (e.g. "deploy", "admin"). Defaults to "admin".',
      },
      maxDelayMs: {
        type: 'number',
        description: 'Stagger window in ms for the client-side jittered reload. Default 30000 (0-30s). Max 300000.',
      },
    },
    required: [],
  },
  handler: async (args: Record<string, unknown> = {}) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    const params: Record<string, unknown> = {};
    if (typeof args.userId === 'string' && args.userId.trim()) params.userId = args.userId.trim();
    if (typeof args.reason === 'string' && args.reason.trim()) params.reason = args.reason.trim();
    if (typeof args.maxDelayMs === 'number' && Number.isFinite(args.maxDelayMs)) {
      params.maxDelayMs = args.maxDelayMs;
    }
    return adminRequest('admin-api.system-refresh-clients', params);
  },
};
