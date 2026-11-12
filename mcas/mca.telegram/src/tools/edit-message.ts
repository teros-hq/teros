import type { ToolConfig } from '@teros/mca-sdk';
import { requireAuthorizedClient, resolveChat, serializeMessage, runCatched } from '../lib/client';

export const editMessage: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Edit a message sent by the linked account. Telegram only allows editing your own messages (in channels, within 48h; in private chats/groups, within 48h unless the chat has longer edit windows).',
  parameters: {
    type: 'object',
    properties: {
      chat: {
        type: 'string',
        description: 'Chat where the message lives: chat ID, @username or t.me link',
      },
      messageId: {
        type: 'number',
        description: 'ID of the message to edit',
      },
      text: {
        type: 'string',
        description: 'New message text (max 4096 characters)',
      },
      linkPreview: {
        type: 'boolean',
        description: 'Show link preview (default: true)',
      },
    },
    required: ['chat', 'messageId', 'text'],
  },
  handler: async (args) =>
    runCatched(async () => {
      const { chat, messageId, text, linkPreview = true } = args as {
        chat: string;
        messageId: number;
        text: string;
        linkPreview?: boolean;
      };
      if (!text || !text.trim()) {
        return { success: false, error: 'text is required' };
      }
      if (text.length > 4096) {
        return { success: false, error: `Text is ${text.length} characters — Telegram allows max 4096.` };
      }
      const client = await requireAuthorizedClient();
      const entity = await resolveChat(client, chat);
      const edited = await client.editMessage(entity, {
        message: messageId,
        text,
        linkPreview,
        parseMode: 'md' as never,
      });
      return { success: true, message: serializeMessage(edited) };
    }),
};
