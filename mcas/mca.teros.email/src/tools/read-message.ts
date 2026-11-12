/**
 * read-message — full content of one message: headers, text and HTML bodies.
 * Does NOT change the read state (that is mark-read).
 */
import type { ToolConfig } from '@teros/mca-sdk';
import { withMailContext } from './helpers.js';

export const readMessage: ToolConfig = {
  description:
    'Read a message in full: headers (from/to/cc/replyTo), subject, date and body (text and HTML when present). Does not change the read state (that is mark-read).',
  parameters: {
    type: 'object',
    properties: {
      messageId: {
        type: 'string',
        description: 'Email id (the one returned by list-messages).',
      },
    },
    required: ['messageId'],
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true },
  handler: async (args, context) => {
    const a = args as { messageId?: string };
    if (!a.messageId || typeof a.messageId !== 'string') {
      throw Object.assign(new Error('[INVALID_REQUEST] messageId is required'), { code: 'INVALID_REQUEST' });
    }
    const ctx = await withMailContext(context);
    const message = await ctx.rt.messages.readMessage(ctx.accountId, a.messageId);
    return { account: ctx.mailbox.account, message };
  },
};
