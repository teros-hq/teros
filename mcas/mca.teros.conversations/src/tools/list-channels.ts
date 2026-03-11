import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { CURRENT_CHANNEL_ID, getWsClient, isWsConnected, type ListChannelsResult } from '../lib';

export const listChannels: ToolConfig = {
  description: 'List past conversations. Returns channel names, agents, and last message preview.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['active', 'closed'],
        description: 'Filter by channel status',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of channels to return (default: 20)',
      },
    },
  },
  handler: async (args) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const status = args?.status as 'active' | 'closed' | undefined;
    const limit = (args?.limit as number) || 20;

    const result = await wsClient.queryConversations<ListChannelsResult>('list_channels', {
      status,
      limit,
      excludeChannelId: CURRENT_CHANNEL_ID,
    });

    return {
      success: true,
      total: result.total,
      channels: result.channels,
    };
  },
};
