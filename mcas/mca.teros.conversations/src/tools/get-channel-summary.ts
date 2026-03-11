import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import {
  CURRENT_CHANNEL_ID,
  type GetChannelSummaryResult,
  getWsClient,
  isWsConnected,
} from '../lib';

export const getChannelSummary: ToolConfig = {
  description:
    'Get a quick summary of a conversation without all messages. Useful to understand what a conversation was about.',
  parameters: {
    type: 'object',
    properties: {
      channelId: {
        type: 'string',
        description: 'The ID of the channel to summarize',
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

    if (!channelId) {
      throw new Error('channelId is required');
    }

    // Prevent accessing current channel
    if (channelId === CURRENT_CHANNEL_ID) {
      throw new Error(
        'Cannot access the current conversation. This tool is for past conversations only.',
      );
    }

    const result = await wsClient.queryConversations<GetChannelSummaryResult>(
      'get_channel_summary',
      { channelId },
    );

    return {
      success: true,
      summary: result,
    };
  },
};
