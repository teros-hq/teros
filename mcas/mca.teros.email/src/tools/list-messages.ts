/**
 * list-messages — messages of one folder, newest first, without bodies.
 *
 * Uses the bug #1 workaround (spec §8): Email/get ids:null + client-side
 * filter/sort/pagination — Email/query with a filter fails on this Stalwart.
 */
import type { ToolConfig } from '@teros/mca-sdk';
import { withMailContext, resolveFolderId } from './helpers.js';

export const listMessages: ToolConfig = {
  description:
    'List messages of a folder, most recent first, without bodies (use read-message for the content). Returns { total, offset, messages: [{ id, from, to, subject, receivedAt, seen, flagged, draft, size }] }.',
  parameters: {
    type: 'object',
    properties: {
      folder: {
        type: 'string',
        description: "Role ('inbox', 'sent', 'drafts', 'trash', 'junk') or exact folder name. Default 'inbox'.",
      },
      limit: {
        type: 'number',
        description: 'Messages to return (default 20, max 50).',
      },
      offset: {
        type: 'number',
        description: 'Skip this many for pagination (default 0).',
      },
      unreadOnly: {
        type: 'boolean',
        description: 'Only unread messages (default false).',
      },
    },
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true },
  handler: async (args, context) => {
    const a = args as { folder?: string; limit?: number; offset?: number; unreadOnly?: boolean };
    const ctx = await withMailContext(context);
    const target = await resolveFolderId(ctx.rt, ctx.mailbox, ctx.accountId, a.folder?.trim() || 'inbox');
    const limit = Math.min(Math.max(1, Math.floor(a.limit ?? 20)), 50);
    const offset = Math.max(0, Math.floor(a.offset ?? 0));
    const result = await ctx.rt.messages.listMessages(ctx.accountId, target.id, {
      limit,
      offset,
      unreadOnly: a.unreadOnly === true,
    });
    return { folder: target.name, role: target.role ?? null, ...result };
  },
};
