import type { ToolConfig } from '@teros/mca-sdk';
import { getClient, isAuthorized, runCatched } from '../lib/client';

export const authStatus: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Check the Telegram connection status: whether the account is linked, who is signed in, and whether real-time event forwarding is active.',
  parameters: { type: 'object', properties: {} },
  handler: async () =>
    runCatched(async () => {
      const authorized = await isAuthorized();
      if (!authorized) {
        return {
          connected: false,
          message:
            'Telegram account not connected. Run auth-send-code with the user\'s phone number to start linking.',
        };
      }
      const client = await getClient();
      const me = await client.getMe();
      const u = me as unknown as {
        id?: unknown;
        firstName?: string;
        lastName?: string;
        username?: string;
        phone?: string;
        premium?: boolean;
      };
      return {
        connected: true,
        account: {
          id: u.id != null ? String(u.id) : null,
          firstName: u.firstName ?? null,
          lastName: u.lastName ?? null,
          username: u.username ?? null,
          phone: u.phone ?? null,
          isPremium: Boolean(u.premium),
        },
      };
    }),
};
