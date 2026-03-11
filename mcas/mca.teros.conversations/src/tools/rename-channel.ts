import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getWsClient, isWsConnected, type RenameChannelResult } from '../lib';

export const renameChannel: ToolConfig = {
  description: 'Rename a conversation. Changes the title/name of a channel.',
  parameters: {
    type: 'object',
    properties: {
      channelId: {
        type: 'string',
        description: 'The ID of the channel to rename',
      },
      name: {
        type: 'string',
        description: 'The new name/title for the conversation',
      },
    },
    required: ['channelId', 'name'],
  },
  handler: async (args) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const channelId = args?.channelId as string;
    const name = args?.name as string;

    if (!channelId) {
      throw new Error('channelId is required');
    }
    if (!name || name.trim().length === 0) {
      throw new Error('name is required and cannot be empty');
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
