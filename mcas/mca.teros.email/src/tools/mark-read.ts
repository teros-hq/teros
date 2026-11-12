/**
 * mark-read — mark messages as read (or unread). Accepts a list so one
 * confirmation covers the whole batch.
 */
import type { ToolConfig } from '@teros/mca-sdk';
import { toolError } from '../lib/errors.js';
import { withMailContext } from './helpers.js';

export const markRead: ToolConfig = {
  description:
    'Mark messages as read or unread. Accepts a list (1..100) so a single confirmation covers the batch. Returns { updated, notUpdated }.',
  parameters: {
    type: 'object',
    properties: {
      messageIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Email ids to mark (from list-messages).',
      },
      seen: {
        type: 'boolean',
        description: 'true = read (default), false = unread.',
      },
    },
    required: ['messageIds'],
  },
  annotations: { version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: async (args, context) => {
    const a = args as { messageIds?: unknown; seen?: boolean };
    const ids = Array.isArray(a.messageIds) ? a.messageIds.map(String).filter(Boolean) : [];
    if (ids.length === 0) {
      throw toolError('INVALID_REQUEST', 'messageIds must be a non-empty list of email ids');
    }
    if (ids.length > 100) {
      throw toolError('INVALID_REQUEST', `Too many messageIds (${ids.length})`, 'split the batch into chunks of at most 100');
    }
    const ctx = await withMailContext(context);
    const result = await ctx.rt.messages.markRead(ctx.accountId, ids, a.seen !== false);
    return {
      account: ctx.mailbox.account,
      seen: a.seen !== false,
      ...result,
    };
  },
};
