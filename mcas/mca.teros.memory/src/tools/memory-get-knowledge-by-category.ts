import type { HttpToolConfig } from '@teros/mca-sdk';
import { getAgentId } from '../lib';
import { ensureQdrantInitialized } from '../qdrant-init';
import { getKnowledgeByCategory } from '@teros/shared/memory/knowledge';

export const memoryGetKnowledgeByCategory: HttpToolConfig = {
  description: 'Get all knowledge items in a specific category',
  parameters: {
    type: 'object',
    properties: {
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
        description: 'Knowledge category',
      },
    },
    required: ['category'],
  },
  handler: async (args, context) => {
    await ensureQdrantInitialized(context);
    const { category } = args as { category: string };
    const agentId = getAgentId(context);
    
    const results = await getKnowledgeByCategory(agentId, category);

    return {
      success: true,
      results,
    };
  },
};
