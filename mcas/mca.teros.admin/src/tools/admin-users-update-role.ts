import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

// User management (tn_h3KIMygPUs0nvl5F, Pablo 2-nov): actions on people, so
// alwaysAsk — human confirmation on EVERY call, session 'allow' is ignored.
export const adminUsersUpdateRole: ToolConfig = {
  annotations: { readOnlyHint: false, alwaysAsk: true },
  description:
    "Change a user's role: user | admin | super. Super admin only (same as the admin panel). Cannot demote yourself. This grants or removes privileges over people and the platform — always requires explicit confirmation.",
  parameters: {
    type: 'object',
    properties: {
      userId: {
        type: 'string',
        description: 'User ID to update (e.g. user_xxx). Find it in the admin panel Users window.',
      },
      role: {
        type: 'string',
        enum: ['user', 'admin', 'super'],
        description: "New role: 'user' (regular), 'admin' (platform admin), 'super' (super admin).",
      },
    },
    required: ['userId', 'role'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.users-update-role', args as Record<string, unknown>);
  },
};
