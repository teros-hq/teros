import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import {
  CURRENT_CHANNEL_ID,
  type GetChannelMessagesResult,
  getWsClient,
  isWsConnected,
} from '../lib';

export const getChannelMessages: ToolConfig = {
  description: 'Get messages from a specific past conversation. Supports pagination.',
  parameters: {
    type: 'object',
    properties: {
      channelId: {
        type: 'string',
        description: 'The ID of the channel to get messages from',
      },
      limit: {
        type: 'number',
        description: 'Number of messages to return (default: 50)',
      },
      before: {
        type: 'string',
        description: 'Message ID for pagination - get messages before this one',
      },
      textOnly: {
        type: 'boolean',
        description: 'Only return text messages, excluding tool executions (default: true)',
      },
    },
    required: ['channelId'],
  },
  handler: async (args) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const channelId = args?.channelId as string;
    const limit = (args?.limit as number) || 50;
    const before = args?.before as string | undefined;
    const textOnly = args?.textOnly !== false;

    if (!channelId) {
      throw new Error('channelId is required');
    }

    // Prevent accessing current channel
    if (channelId === CURRENT_CHANNEL_ID) {
      throw new Error(
        'Cannot access the current conversation. This tool is for past conversations only.',
      );
    }

    const result = await wsClient.queryConversations<GetChannelMessagesResult>(
      'get_channel_messages',
      {
        channelId,
        limit,
        before,
        textOnly,
      },
    );

    return {
      success: true,
      channel: result.channel,
      messageCount: result.messages.length,
      hasMore: result.hasMore,
      messages: result.messages,
    };
  },
};
