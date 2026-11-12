import type { ToolConfig } from '@teros/mca-sdk';
import {
  getClient,
  loadAuthState,
  clearAuthState,
  persistSession,
  toToolError,
} from '../lib/client';
import { bootstrapEventForwarding } from '../lib/events';
import { errors } from 'teleproto';

export const authSignIn: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Step 2 of linking a Telegram account: complete sign-in with the code the user received (from auth-send-code). If the account has two-factor authentication enabled, pass the 2FA password too. On success the session is persisted and the account is linked.',
  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'The login code the user received in Telegram (or by SMS)',
      },
      password: {
        type: 'string',
        description: 'Two-factor authentication password (only if the account has 2FA enabled)',
      },
    },
    required: ['code'],
  },
  handler: async (args) => {
    const { code, password } = args as { code: string; password?: string };
    try {
      const state = loadAuthState();
      if (!state) {
        return {
          success: false,
          error:
            'No pending sign-in. Call auth-send-code with the user\'s phone number first (a previous code may have expired — resend).',
        };
      }
      const client = await getClient();
      const { apiId, apiHash } = {
        apiId: parseInt(process.env.TELEGRAM_API_ID || '', 10),
        apiHash: process.env.TELEGRAM_API_HASH || '',
      };
      const apiCredentials = { apiId, apiHash };
      const user = await client.signInUser(apiCredentials, {
        phoneNumber: state.phoneNumber,
        phoneCode: async () => code,
        password: password ? async () => password : undefined,
        onError: async (err: Error) => {
          console.error('[mca.telegram] sign-in error:', err.message);
          return true; // stop the flow — we surface the error ourselves
        },
      });
      // Persist the session immediately — this is what makes the link survive
      // container restarts.
      persistSession(client);
      clearAuthState();
      // Native event forwarding: activate it the moment the account is linked
      // (no-op when the backend callback is unknown; boot already logged it).
      await bootstrapEventForwarding();
      const u = user as unknown as {
        id?: unknown;
        firstName?: string;
        lastName?: string;
        username?: string;
      };
      return {
        success: true,
        connected: true,
        account: {
          id: u.id != null ? String(u.id) : null,
          firstName: u.firstName ?? null,
          lastName: u.lastName ?? null,
          username: u.username ?? null,
        },
        message: 'Telegram account linked. The session persists across restarts.',
      };
    } catch (err) {
      if (err instanceof errors.SessionPasswordNeededError) {
        return {
          success: false,
          needsPassword: true,
          error:
            'This account has two-factor authentication enabled. Ask the user for their 2FA password and call auth-sign-in again with code + password.',
        };
      }
      return toToolError(err);
    }
  },
};
