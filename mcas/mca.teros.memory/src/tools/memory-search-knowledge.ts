import type { HttpToolConfig } from '@teros/mca-sdk';
import { getAgentId } from '../lib';
import { ensureQdrantInitialized } from '../qdrant-init';
import { searchKnowledge } from '@teros/shared/memory/knowledge';

export const memorySearchKnowledge: HttpToolConfig = {
  description: 'Search through the knowledge base',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query',
      },
      category: {
        type: 'string',
        enum: [
          'user_preferences',
          'project_data',
          'commands',
          'coding_patterns',
          'tools',
          'workflows',
        ],
        description: 'Optional category filter',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results',
        default: 5,
      },
    },
    required: ['query'],
  },
  handler: async (args, context) => {
    await ensureQdrantInitialized(context);
    const {
      query,
      category,
      limit = 5,
    } = args as {
      query: string;
      category?: string;
      limit?: number;
    };

    const agentId = getAgentId(context);
    const results = await searchKnowledge(agentId, query, limit, category);

    return {
      success: true,
      results,
    };
  },
};
