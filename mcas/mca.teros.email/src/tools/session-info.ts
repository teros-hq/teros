/**
 * session-info — identity of this email instance: mailbox, JMAP accountId,
 * capabilities and connection state. First call to diagnose connection or
 * credentials.
 */
import type { ToolConfig } from '@teros/mca-sdk';
import { withMailContext } from './helpers.js';

export const sessionInfo: ToolConfig = {
  description:
    'Identity of this email instance: mailbox (MAIL_ACCOUNT), JMAP accountId, username, apiUrl, transport mode and password source (derived/user). First call to diagnose connection or credentials.',
  parameters: {
    type: 'object',
    properties: {},
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true },
  handler: async (_args, context) => {
    const ctx = await withMailContext(context);
    return {
      account: ctx.mailbox.account,
      accountId: ctx.accountId,
      username: ctx.session.username ?? null,
      apiUrl: ctx.session.apiUrl ?? null,
      transport: ctx.rt.mode,
      passwordSource: ctx.mailbox.passwordSource,
      fromName: ctx.mailbox.fromName ?? null,
    };
  },
};
