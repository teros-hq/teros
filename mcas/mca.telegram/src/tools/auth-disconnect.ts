import type { ToolConfig } from '@teros/mca-sdk';
import { Api } from 'teleproto';
import {
  getClient,
  isAuthorized,
  clearSession,
  resetClient,
  runCatched,
} from '../lib/client';
import { stopEventWatcher } from '../lib/events';

export const authDisconnect: ToolConfig = {
  annotations: { readOnlyHint: false, irreversible: true, destructiveHint: true },
  description:
    'Disconnect the linked Telegram account: logs out from Telegram (invalidating the session on Telegram\'s side), wipes the persisted session, and stops real-time event forwarding.',
  parameters: { type: 'object', properties: {} },
  handler: async () =>
    runCatched(async () => {
      if (!(await isAuthorized())) {
        clearSession();
        return { success: true, connected: false, message: 'No account was connected. Session files cleared.' };
      }
      const client = await getClient();
      // LogOut invalidates the session server-side (shows up as an active
      // session removal in the user's Telegram settings).
      await client.invoke(new Api.auth.LogOut());
      await resetClient();
      clearSession();
      stopEventWatcher();
      return {
        success: true,
        connected: false,
        message: 'Telegram account disconnected and session removed.',
      };
    }),
};
