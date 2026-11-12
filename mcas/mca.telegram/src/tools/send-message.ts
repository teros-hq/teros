import type { ToolConfig } from '@teros/mca-sdk';
import { requireAuthorizedClient, resolveChat, serializeMessage, runCatched } from '../lib/client';

export const sendMessage: ToolConfig = {
  annotations: { readOnlyHint: false, safeWriteHint: true },
  description:
    'Send a text message to a Telegram chat (private chat, group, supergroup or channel). Supports replying to a specific message and disabling the link preview.',
  parameters: {
    type: 'object',
    properties: {
      chat: {
        type: 'string',
        description: 'Destination: chat ID from list-chats, @username, or t.me link',
      },
      text: {
        type: 'string',
        description: 'Message text (max 4096 characters). Markdown formatting (**bold**, __italic__, `code`) is parsed by default.',
      },
      replyToMsgId: {
        type: 'number',
        description: 'Message ID to reply to (optional)',
      },
      linkPreview: {
        type: 'boolean',
        description: 'Show link preview (default: true)',
      },
      parseMarkdown: {
        type: 'boolean',
        description: 'Parse Markdown formatting in the text (default: true). Set false to send raw text.',
      },
    },
    required: ['chat', 'text'],
  },
  handler: async (args) =>
    runCatched(async () => {
      const { chat, text, replyToMsgId, linkPreview = true, parseMarkdown = true } = args as {
        chat: string;
        text: string;
        replyToMsgId?: number;
        linkPreview?: boolean;
        parseMarkdown?: boolean;
      };
      if (!text || !text.trim()) {
        return { success: false, error: 'text is required (use send-media to send files)' };
      }
      if (text.length > 4096) {
        return { success: false, error: `Text is ${text.length} characters — Telegram allows max 4096. Split the message.` };
      }
      const client = await requireAuthorizedClient();
      const entity = await resolveChat(client, chat);
      const sent = await client.sendMessage(entity, {
        message: text,
        replyTo: replyToMsgId ?? undefined,
        linkPreview,
        parseMode: parseMarkdown ? ('md' as never) : undefined,
      });
      return {
        success: true,
        message: serializeMessage(sent),
      };
    }),
};
