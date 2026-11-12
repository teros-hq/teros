import type { ToolConfig } from '@teros/mca-sdk';
import { Api } from 'teleproto';
import { requireAuthorizedClient, serializeMessage, runCatched } from '../lib/client';

export const searchMessages: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Search the user\'s Telegram messages. Two modes: global search across all conversations (default), or scoped search inside one chat (pass `chat`).',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Text to search for',
      },
      chat: {
        type: 'string',
        description: 'Optional: limit the search to this chat (chat ID, @username or t.me link). Without it, searches all conversations.',
      },
      limit: {
        type: 'number',
        description: 'Max results to return (default: 20, max: 50)',
      },
      fromUser: {
        type: 'string',
        description: 'Only messages from this user (only valid with `chat`)',
      },
    },
    required: ['query'],
  },
  handler: async (args) =>
    runCatched(async () => {
      const { query, chat, limit = 20, fromUser } = args as {
        query: string;
        chat?: string;
        limit?: number;
        fromUser?: string;
      };
      if (!query || !String(query).trim()) {
        return { success: false, error: 'query is required (text to search for)' };
      }
      const capped = Math.min(Math.max(1, limit), 50);
      const client = await requireAuthorizedClient();

      if (chat) {
        // Scoped search — server-side via messages.Search inside the chat.
        const { resolveChat } = await import('../lib/client');
        const entity = await resolveChat(client, chat);
        const messages = await client.getMessages(entity, {
          limit: capped,
          search: query,
          fromUser: fromUser ?? undefined,
        });
        return { success: true, scope: chat, count: messages.length, messages: messages.map(serializeMessage) };
      }

      // Global search across all dialogs.
      const me = await client.getMe();
      const result = await client.invoke(
        new Api.messages.SearchGlobal({
          q: query,
          filter: new Api.InputMessagesFilterEmpty(),
          minDate: 0,
          maxDate: 0,
          offsetRate: 0,
          offsetId: 0,
          offsetPeer: new Api.InputPeerEmpty(),
          limit: capped,
        }),
      );
      const res = result as unknown as {
        messages?: unknown[];
        users?: unknown[];
        chats?: unknown[];
        className?: string;
      };
      const users = new Map<string, Record<string, unknown>>();
      for (const u of res.users ?? []) {
        const uu = u as { id?: unknown };
        if (uu.id != null) users.set(String(uu.id), u as Record<string, unknown>);
      }
      const chats = new Map<string, Record<string, unknown>>();
      for (const c of res.chats ?? []) {
        const cc = c as { id?: unknown };
        if (cc.id != null) chats.set(String(cc.id), c as Record<string, unknown>);
      }
      const messages = (res.messages ?? []).map((m) => {
        const s = serializeMessage(m);
        const from = s.fromId ? users.get(s.fromId) : undefined;
        const inChat = s.chatId
          ? chats.get(s.chatId.replace(/^-100/, '')) ?? users.get(s.chatId)
          : undefined;
        return {
          ...s,
          fromName: from
            ? (from as { firstName?: string; lastName?: string; title?: string; username?: string }).username
              ? `@${(from as { username?: string }).username}`
              : [(from as { firstName?: string }).firstName, (from as { lastName?: string }).lastName].filter(Boolean).join(' ') || null
            : null,
          chatTitle: inChat
            ? (inChat as { title?: string; username?: string }).title ??
              (inChat as { username?: string }).username ?? null
            : null,
        };
      });
      return { success: true, scope: 'global', count: messages.length, messages };
    }),
};
