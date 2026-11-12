import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

// User management (tn_h3KIMygPUs0nvl5F, Pablo 2-nov): actions on people, so
// alwaysAsk — human confirmation on EVERY call, session 'allow' is ignored.
export const adminUsersGrantAccess: ToolConfig = {
  annotations: { readOnlyHint: false, alwaysAsk: true },
  description:
    'Grant platform access to a waitlisted user (accessGranted: true). The user receives the access-granted email when email is configured. Admin only. This is an action on a person — always requires explicit confirmation.',
  parameters: {
    type: 'object',
    properties: {
      userId: {
        type: 'string',
        description: 'User ID to grant access to (e.g. user_xxx). Find it in the admin panel Users window.',
      },
    },
    required: ['userId'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.users-grant-access', args as Record<string, unknown>);
  },
};
