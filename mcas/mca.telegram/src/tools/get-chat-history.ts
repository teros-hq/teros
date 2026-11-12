import type { ToolConfig } from '@teros/mca-sdk';
import { Api } from 'teleproto';
import { requireAuthorizedClient, resolveChat, serializeMessage, runCatched } from '../lib/client';

export const getChatHistory: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Read message history from any Telegram chat (private, group, supergroup or channel). Returns newest-first by default with pagination support.',
  parameters: {
    type: 'object',
    properties: {
      chat: {
        type: 'string',
        description: 'Chat identifier: chat ID from list-chats (e.g. "-1001234567890" or "5612345678"), @username, or t.me link',
      },
      limit: {
        type: 'number',
        description: 'Max messages to return (default: 20, max: 100)',
      },
      offsetId: {
        type: 'number',
        description: 'Return messages older than this message ID (for pagination — use the oldest ID of the previous page)',
      },
      minId: {
        type: 'number',
        description: 'Return only messages newer than this message ID',
      },
      fromUser: {
        type: 'string',
        description: 'Only messages from this user (@username or user ID)',
      },
      search: {
        type: 'string',
        description: 'Only messages containing this text',
      },
      order: {
        type: 'string',
        description: '"desc" (newest first, default) or "asc" (oldest first)',
      },
    },
    required: ['chat'],
  },
  handler: async (args) =>
    runCatched(async () => {
      const {
        chat,
        limit = 20,
        offsetId,
        minId,
        fromUser,
        search,
        order = 'desc',
      } = args as {
        chat: string;
        limit?: number;
        offsetId?: number;
        minId?: number;
        fromUser?: string;
        search?: string;
        order?: 'desc' | 'asc';
      };
      const capped = Math.min(Math.max(1, limit), 100);
      const client = await requireAuthorizedClient();
      const entity = await resolveChat(client, chat);
      const messages = await client.getMessages(entity, {
        limit: capped,
        offsetId: offsetId ?? undefined,
        minId: minId ?? undefined,
        fromUser: fromUser ?? undefined,
        search: search || undefined,
        reverse: order === 'asc',
      });
      return {
        success: true,
        chat,
        count: messages.length,
        messages: messages.map(serializeMessage),
      };
    }),
};
