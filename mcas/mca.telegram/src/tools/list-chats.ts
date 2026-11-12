import type { ToolConfig } from '@teros/mca-sdk';
import { requireAuthorizedClient, serializeChatEntity, runCatched } from '../lib/client';

export const listChats: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List the user\'s Telegram conversations (dialogs): private chats, groups, supergroups and channels, most-recent first. Returns chat IDs usable with the other tools.',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Max conversations to return (default: 20, max: 100)',
      },
      archived: {
        type: 'boolean',
        description: 'List archived conversations instead of the main list (default: false)',
      },
    },
  },
  handler: async (args) =>
    runCatched(async () => {
      const { limit = 20, archived = false } = args as { limit?: number; archived?: boolean };
      const capped = Math.min(Math.max(1, limit), 100);
      const client = await requireAuthorizedClient();
      const dialogs = await client.getDialogs({
        limit: capped,
        archived,
      });
      return {
        success: true,
        count: dialogs.length,
        chats: dialogs.map((d) => {
          const base = serializeChatEntity(d.entity);
          return {
            ...base,
            unreadCount: d.unreadCount,
            isPinned: d.pinned,
            isArchived: d.archived,
            lastMessageDate: d.date ? new Date(d.date * 1000).toISOString() : null,
            lastMessagePreview:
              d.message && (d.message as unknown as { message?: string }).message
                ? String((d.message as unknown as { message?: string }).message).slice(0, 120)
                : null,
          };
        }),
      };
    }),
};
