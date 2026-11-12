import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

/**
 * admin-apps-copy-auth — admin replica of copy-app-auth (task
 * tn_aGVdSrVwIJi9mfvc). Follows the admin MCA pattern: WS adminRequest →
 * admin-api.apps-copy-auth (backend handler in handlers/domains/admin-api/apps.ts).
 *
 * `alwaysAsk: true` — every credential copy requires human confirmation.
 */
export const adminAppsCopyAuth: ToolConfig = {
  annotations: { readOnlyHint: false, alwaysAsk: true },
  description:
    "Copy the COMPLETE authentication (user secrets + OAuth tokens with refresh) from one app instance to another of the same app type — cross-workspace. Full replace on the target (set semantics). Whose credential is copied: the explicit userId when given, else the owner of the source app's workspace. The response lists only the copied field names and masks — values are NEVER exposed. OAuth caveat: both instances share the same tokens afterwards; if the provider rotates refresh tokens, one instance can invalidate the other. Super admin only.",
  parameters: {
    type: 'object',
    properties: {
      sourceAppId: { type: 'string', description: 'App instance to copy the credentials FROM (must already be connected)' },
      targetAppId: { type: 'string', description: 'App instance to copy the credentials TO (same mcaId as the source)' },
      userId: {
        type: 'string',
        description: "Optional: whose credential to copy. Default: the owner of the source app's workspace (the user who typically connected it).",
      },
      sourceWorkspaceId: { type: 'string', description: 'Required: the workspace the source app lives in — cross-workspace tools always name their workspaces (Teros infra is sharded by workspaceId)' },
      targetWorkspaceId: { type: 'string', description: 'Required: the workspace the target app lives in — cross-workspace tools always name their workspaces (Teros infra is sharded by workspaceId)' },
    },
    required: ['sourceAppId', 'targetAppId', 'sourceWorkspaceId', 'targetWorkspaceId'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.apps-copy-auth', args as Record<string, unknown>);
  },
};
