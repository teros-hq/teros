import type { HttpToolConfig } from '@teros/mca-sdk';
import { getAgentId, getFilterContext } from '../lib';
import { ensureQdrantInitialized } from '../qdrant-init';
import { searchConversations } from '@teros/shared/memory/conversation';

export const memorySearchConversations: HttpToolConfig = {
  description: 'Search through conversation history using semantic search',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query to find relevant conversations',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return',
        default: 5,
      },
    },
    required: ['query'],
  },
  handler: async (args, context) => {
    await ensureQdrantInitialized(context);
    const { query, limit = 5 } = args as { query: string; limit?: number };
    const agentId = getAgentId(context);
    const { channelId } = getFilterContext(context);

    const results = await searchConversations(
      agentId,
      query,
      limit,
      channelId ? { channelId } : undefined
    );

    return {
      success: true,
      results,
    };
  },
};
