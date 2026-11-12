import type { ToolConfig } from '@teros/mca-sdk';
import {
  getClient,
  isAuthorized,
  saveAuthState,
  clearAuthState,
  runCatched,
} from '../lib/client';

export const authSendCode: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Step 1 of linking a Telegram account: request a login code for the given phone number. Telegram sends the code to the user\'s Telegram app (or SMS). Then call auth-sign-in with the code the user provides. If the account has 2FA enabled, auth-sign-in will also ask for the password.',
  parameters: {
    type: 'object',
    properties: {
      phoneNumber: {
        type: 'string',
        description: 'Phone number in international format, e.g. "+34612345678"',
      },
    },
    required: ['phoneNumber'],
  },
  handler: async (args) =>
    runCatched(async () => {
      const { phoneNumber } = args as { phoneNumber: string };
      const phone = phoneNumber.trim().replace(/[\s()-]/g, '');
      if (!/^\+?\d{6,15}$/.test(phone)) {
        return {
          success: false,
          error: 'Invalid phone number. Use international format, e.g. "+34612345678".',
        };
      }
      if (await isAuthorized()) {
        return {
          success: false,
          error: 'A Telegram account is already connected. Use auth-disconnect first to link a different account.',
        };
      }
      const client = await getClient();
      const { apiId, apiHash } = { apiId: parseInt(process.env.TELEGRAM_API_ID || '', 10), apiHash: process.env.TELEGRAM_API_HASH || '' };
      const result = await client.sendCode({ apiId, apiHash }, phone);
      // Persist the phoneCodeHash — auth-sign-in needs it to complete the flow.
      saveAuthState({
        phoneCodeHash: result.phoneCodeHash,
        phoneNumber: phone,
        createdAt: Date.now(),
      });
      return {
        success: true,
        sentTo: phone,
        viaApp: result.isCodeViaApp,
        message:
          'Code sent. Ask the user for the code they received in Telegram (or by SMS) and call auth-sign-in with it.',
      };
    }),
};
