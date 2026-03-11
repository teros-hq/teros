import type { HttpToolConfig } from '@teros/mca-sdk';
import { getAgentId, getFilterContext } from '../lib';
import { ensureQdrantInitialized } from '../qdrant-init';
import { getRecentConversations } from '@teros/shared/memory/conversation';

export const memoryGetRecentConversations: HttpToolConfig = {
  description: 'Get most recent conversations',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum number of conversations to return',
        default: 10,
      },
    },
  },
  handler: async (args, context) => {
    await ensureQdrantInitialized(context);
    const { limit = 10 } = args as { limit?: number };
    const agentId = getAgentId(context);
    const { channelId } = getFilterContext(context);

    const results = await getRecentConversations(
      agentId,
      limit,
      channelId ? { channelId } : undefined
    );

    return {
      success: true,
      results,
    };
  },
};
