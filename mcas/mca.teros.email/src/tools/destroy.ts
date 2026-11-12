/**
 * destroy — DESTROY messages permanently (irreversible — they do NOT go to
 * Trash). Use only with explicit user confirmation.
 */
import type { ToolConfig } from '@teros/mca-sdk';
import { toolError } from '../lib/errors.js';
import { withMailContext } from './helpers.js';

export const destroy: ToolConfig = {
  description:
    'DESTROY messages permanently — irreversible, they do NOT pass through Trash. Use only with explicit user confirmation. Returns { destroyed, notDestroyed }.',
  parameters: {
    type: 'object',
    properties: {
      messageIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Email ids to destroy (from list-messages).',
      },
    },
    required: ['messageIds'],
  },
  annotations: { version: '1.0.0', stability: 'stable', destructiveHint: true, irreversible: true },
  handler: async (args, context) => {
    const a = args as { messageIds?: unknown };
    const ids = Array.isArray(a.messageIds) ? a.messageIds.map(String).filter(Boolean) : [];
    if (ids.length === 0) {
      throw toolError('INVALID_REQUEST', 'messageIds must be a non-empty list of email ids');
    }
    if (ids.length > 100) {
      throw toolError('INVALID_REQUEST', `Too many messageIds (${ids.length})`, 'split the batch into chunks of at most 100');
    }
    const ctx = await withMailContext(context);
    const result = await ctx.rt.messages.destroy(ctx.accountId, ids);
    return {
      account: ctx.mailbox.account,
      ...result,
    };
  },
};
