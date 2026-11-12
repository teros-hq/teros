import type { ToolConfig } from '@teros/mca-sdk';
import { Api } from 'teleproto';
import { requireAuthorizedClient, serializeChatEntity, runCatched } from '../lib/client';

export const createGroup: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a new Telegram group or channel. kind="group" creates a small group chat with the given members; kind="supergroup" creates a large group; kind="channel" creates a broadcast channel. Returns the new chat\'s ID for use with the other tools.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Name of the group or channel',
      },
      kind: {
        type: 'string',
        description: '"group" (small chat, default), "supergroup" (large/forum group) or "channel" (broadcast)',
      },
      about: {
        type: 'string',
        description: 'Optional description (supergroups and channels only)',
      },
      members: {
        type: 'array',
        items: { type: 'string' },
        description: 'Usernames or user IDs to add as initial members (@username or numeric ID). Required for kind="group" (at least 1 besides you); optional for supergroups/channels.',
      },
    },
    required: ['title'],
  },
  handler: async (args) =>
    runCatched(async () => {
      const { title, kind = 'group', about, members = [] } = args as {
        title: string;
        kind?: 'group' | 'supergroup' | 'channel';
        about?: string;
        members?: string[];
      };
      if (!title.trim()) {
        return { success: false, error: 'title is required' };
      }
      const client = await requireAuthorizedClient();

      if (kind === 'group') {
        if (!members.length) {
          return {
            success: false,
            error: 'A basic group needs at least one initial member. Pass members: [@username or user ID], or use kind="supergroup".',
          };
        }
        const users = [];
        for (const m of members.slice(0, 10)) {
          users.push(await client.getEntity(m));
        }
        const updates = await client.createChat({ title, users });
        const created = (updates as unknown as { chats?: unknown[] }).chats?.[0];
        const chatInfo = created ? serializeChatEntity(created) : {};
        return {
          success: true,
          kind,
          chat: chatInfo,
          invited: members.slice(0, 10),
          message: 'Group created. Use the chat.id with the other tools.',
        };
      }

      // supergroup | channel → channels.createChannel
      const channel = await client.createChannel({
        title,
        about: about || undefined,
        megagroup: kind === 'supergroup',
      });
      const info = serializeChatEntity(channel);

      // Invite initial members if provided.
      let invited: string[] = [];
      if (members.length) {
        const users = [];
        for (const m of members.slice(0, 200)) {
          users.push(await client.getInputEntity(m));
        }
        if (users.length) {
          await client.invoke(
            new Api.channels.InviteToChannel({
              channel: await client.getInputEntity(channel),
              users,
            }),
          );
          invited = members.slice(0, 200);
        }
      }
      return {
        success: true,
        kind,
        chat: info,
        invited,
        message: `${kind === 'channel' ? 'Channel' : 'Supergroup'} created. Use the chat.id with the other tools.`,
      };
    }),
};
