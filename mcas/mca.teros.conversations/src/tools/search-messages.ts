import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { CURRENT_CHANNEL_ID, getWsClient, isWsConnected, type SearchMessagesResult } from '../lib';

export const searchMessages: ToolConfig = {
  description:
    'Search for text in messages across all past conversations. Returns matches grouped by channel with context snippets.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Text to search for (case-insensitive, minimum 2 characters)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default: 50, max: 100)',
      },
    },
    required: ['query'],
  },
  handler: async (args) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const query = args?.query as string;
    const limit = Math.min((args?.limit as number) || 50, 100);

    if (!query || query.length < 2) {
      throw new Error('Query must be at least 2 characters');
    }

    const result = await wsClient.queryConversations<SearchMessagesResult>('search_messages', {
      query,
      limit,
      excludeChannelId: CURRENT_CHANNEL_ID,
    });

    return {
      success: true,
      query,
      totalMatches: result.totalMatches,
      channelsWithMatches: result.results.length,
      results: result.results,
    };
  },
};
