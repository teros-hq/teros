import type { ToolConfig } from '@teros/mca-sdk';
import { requireAuthorizedClient, resolveChat, runCatched } from '../lib/client';

export const markAsRead: ToolConfig = {
  annotations: { readOnlyHint: false, safeWriteHint: true },
  description:
    'Mark messages in a Telegram chat as read (clears the unread counter and mention badge).',
  parameters: {
    type: 'object',
    properties: {
      chat: {
        type: 'string',
        description: 'Chat to mark as read: chat ID, @username or t.me link',
      },
      maxId: {
        type: 'number',
        description: 'Mark messages up to this ID as read (default: all current messages)',
      },
    },
    required: ['chat'],
  },
  handler: async (args) =>
    runCatched(async () => {
      const { chat, maxId } = args as { chat: string; maxId?: number };
      const client = await requireAuthorizedClient();
      const entity = await resolveChat(client, chat);
      await client.markAsRead(entity, maxId ?? undefined);
      return { success: true, chat, markedUpTo: maxId ?? 'latest' };
    }),
};
