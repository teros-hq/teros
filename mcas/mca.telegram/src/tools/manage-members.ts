import type { ToolConfig } from '@teros/mca-sdk';
import { Api } from 'teleproto';
import { requireAuthorizedClient, resolveChat, serializeUser, runCatched } from '../lib/client';

export const manageMembers: ToolConfig = {
  annotations: { readOnlyHint: false, destructiveHint: true },
  description:
    'Manage members of a Telegram group/supergroup/channel: list members, add (invite) a user, remove/kick a user, or ban/unban a user. Listing requires the account to have access to the member list; kick/ban require admin rights.',
  parameters: {
    type: 'object',
    properties: {
      chat: {
        type: 'string',
        description: 'Group/supergroup/channel: chat ID, @username or t.me link',
      },
      action: {
        type: 'string',
        description: '"list" (default), "add", "remove", "ban" or "unban"',
      },
      user: {
        type: 'string',
        description: 'Target user: @username or user ID (required for add/remove/ban/unban)',
      },
      limit: {
        type: 'number',
        description: 'For action="list": max members to return (default: 50, max: 200)',
      },
    },
    required: ['chat', 'action'],
  },
  handler: async (args) =>
    runCatched(async () => {
      const { chat, action = 'list', user, limit = 50 } = args as {
        chat: string;
        action?: 'list' | 'add' | 'remove' | 'ban' | 'unban';
        user?: string;
        limit?: number;
      };
      if (action !== 'list' && !user) {
        return { success: false, error: `user is required for action="${action}" (@username or user ID)` };
      }
      const target = user as string;
      const client = await requireAuthorizedClient();
      const entity = await resolveChat(client, chat);

      if (action === 'list') {
        const capped = Math.min(Math.max(1, limit), 200);
        const participants = [];
        for await (const p of client.iterParticipants(entity, { limit: capped })) {
          const user = (p as unknown as { user?: unknown }).user ?? p;
          participants.push(serializeUser(user));
        }
        return { success: true, action, count: participants.length, members: participants };
      }

      if (action === 'add') {
        const inputUser = await client.getInputEntity(target);
        await client.invoke(
          new Api.channels.InviteToChannel({
            channel: (await client.getInputEntity(entity as never)) as never,
            users: [inputUser as never],
          }),
        );
        return { success: true, action, user, message: `Invited ${user} to the chat.` };
      }

      if (action === 'remove') {
        // Kick = ban with a view-restriction that expired in the past; the
        // standard MTProto idiom for removing a member without a ban.
        const inputUser = await client.getInputEntity(target);
        await client.invoke(
          new Api.channels.EditBanned({
            channel: (await client.getInputEntity(entity as never)) as never,
            participant: inputUser as never,
            bannedRights: new Api.ChatBannedRights({
              untilDate: 0,
              viewMessages: true,
            }),
          }),
        );
        return { success: true, action, user, message: `Removed ${user} from the chat.` };
      }

      if (action === 'ban') {
        const inputUser = await client.getInputEntity(target);
        await client.invoke(
          new Api.channels.EditBanned({
            channel: (await client.getInputEntity(entity as never)) as never,
            participant: inputUser as never,
            bannedRights: new Api.ChatBannedRights({
              untilDate: Math.floor(Date.now() / 1000) + 366 * 24 * 3600, // ~1 year
              viewMessages: true,
              sendMessages: true,
              sendMedia: true,
              sendStickers: true,
              sendGifs: true,
              sendGames: true,
              sendInline: true,
              embedLinks: true,
              sendPolls: true,
              changeInfo: true,
              inviteUsers: true,
              pinMessages: true,
            }),
          }),
        );
        return { success: true, action, user, message: `Banned ${user} for 1 year.` };
      }

      // unban
      const inputUser = await client.getInputEntity(target);
      await client.invoke(
        new Api.channels.EditBanned({
          channel: (await client.getInputEntity(entity as never)) as never,
          participant: inputUser as never,
          bannedRights: new Api.ChatBannedRights({ untilDate: 0 }),
        }),
      );
      return { success: true, action, user, message: `Lifted restrictions for ${user}.` };
    }),
};
