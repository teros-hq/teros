import type { ToolConfig } from '@teros/mca-sdk';
import { requireAuthorizedClient, resolveChat, runCatched } from '../lib/client';

export const deleteMessages: ToolConfig = {
  annotations: { readOnlyHint: false, destructiveHint: true, irreversible: true },
  description:
    'Delete one or more messages in a chat. With revoke=true (default) the messages are deleted for EVERYONE in the chat; with revoke=false they are only deleted for the linked account. Deleting other people\'s messages requires admin rights in groups/channels.',
  parameters: {
    type: 'object',
    properties: {
      chat: {
        type: 'string',
        description: 'Chat where the messages live: chat ID, @username or t.me link',
      },
      messageIds: {
        type: 'array',
        items: { type: 'number' },
        description: 'IDs of the messages to delete (one or more)',
      },
      revoke: {
        type: 'boolean',
        description: 'Delete for everyone (default: true). false = only delete for yourself.',
      },
    },
    required: ['chat', 'messageIds'],
  },
  handler: async (args) =>
    runCatched(async () => {
      const { chat, messageIds, revoke = true } = args as {
        chat: string;
        messageIds: number[];
        revoke?: boolean;
      };
      if (!Array.isArray(messageIds) || messageIds.length === 0) {
        return { success: false, error: 'messageIds must be a non-empty array of message IDs' };
      }
      if (messageIds.length > 100) {
        return { success: false, error: 'Telegram allows deleting at most 100 messages per call' };
      }
      const client = await requireAuthorizedClient();
      const entity = await resolveChat(client, chat);
      await client.deleteMessages(entity, messageIds, { revoke });
      return {
        success: true,
        deleted: messageIds,
        forEveryone: revoke,
      };
    }),
};
