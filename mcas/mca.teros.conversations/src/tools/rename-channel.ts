import type { HttpToolConfig as ToolConfig, ToolContext } from '@teros/mca-sdk';
import { CURRENT_CHANNEL_ID, getWsClient, type RenameChannelResult, isWsConnected } from '../lib';

export const renameChannel: ToolConfig = {
  // safeWriteHint: renames a conversation — reversible (rename back) and private.
  annotations: { readOnlyHint: false, safeWriteHint: true },
  description:
    'Rename a conversation. Changes the title/name of a channel. Without channelId it renames the current conversation. Conversations linked to a board task cannot be renamed — rename the task instead and the conversation follows.',
  parameters: {
    type: 'object',
    properties: {
      channelId: {
        type: 'string',
        description:
          'The ID of the channel to rename. Optional — defaults to the current conversation.',
      },
      name: {
        type: 'string',
        description: 'The new name/title for the conversation',
      },
    },
    required: ['name'],
  },
  handler: async (args, context: ToolContext) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const name = args?.name as string;

    if (!name || name.trim().length === 0) {
      throw new Error('name is required and cannot be empty');
    }
    if (name.trim().length > 200) {
      throw new Error('name is too long (max 200 characters)');
    }

    // Default to the channel the tool is running in. context.execution.channelId
    // is the reliable per-call source; CURRENT_CHANNEL_ID (spawn-time env) is a
    // last resort (same pattern as import-attachment).
    const channelId =
      (args?.channelId as string) || context.execution.channelId || CURRENT_CHANNEL_ID || undefined;

    if (!channelId) {
      throw new Error('channelId is required (no current channel in context)');
    }

    const result = await wsClient.queryConversations<RenameChannelResult>('rename_channel', {
      channelId,
      name,
    });

    return {
      success: true,
      channelId: result.channelId,
      name: result.name,
    };
  },
};
