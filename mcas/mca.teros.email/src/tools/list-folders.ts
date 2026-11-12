/**
 * list-folders — folders of this mailbox (Inbox, Sent, Drafts, Trash…)
 * with role, total emails and unread count. Use the returned roles or names
 * as `folder` in list-messages.
 */
import type { ToolConfig } from '@teros/mca-sdk';
import { withMailContext } from './helpers.js';

export const listFolders: ToolConfig = {
  description:
    "Folders of this mailbox (Inbox, Sent, Drafts, Trash, …) with role, total emails and unread count. Use the returned roles as 'folder' in list-messages.",
  parameters: {
    type: 'object',
    properties: {},
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true },
  handler: async (_args, context) => {
    const ctx = await withMailContext(context);
    const folders = await ctx.rt.client.listMailboxes(ctx.mailbox.account, ctx.mailbox.password, ctx.accountId);
    return {
      account: ctx.mailbox.account,
      folders: folders.map((f) => ({
        id: f.id,
        name: f.name,
        role: f.role ?? null,
        totalEmails: f.totalEmails ?? null,
        unreadEmails: f.unreadEmails ?? null,
      })),
    };
  },
};
