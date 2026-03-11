import type { HttpToolConfig } from '@teros/mca-sdk';
import { getAgentId, getFilterContext } from '../lib';
import { saveKnowledge } from '@teros/shared/memory/knowledge';
import { ensureQdrantInitialized } from '../qdrant-init';

export const memorySaveKnowledge: HttpToolConfig = {
  description: 'Save a piece of knowledge to the knowledge base',
  parameters: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The knowledge content to save',
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
        description: 'Category of knowledge',
      },
      confidence: {
        type: 'number',
        description: 'Confidence score (0-1)',
        default: 0.8,
      },
    },
    required: ['content', 'category'],
  },
  handler: async (args, context) => {
    await ensureQdrantInitialized(context);
    
    const {
      content,
      category,
      confidence = 0.8,
    } = args as {
      content: string;
      category: string;
      confidence?: number;
    };

    const agentId = getAgentId(context);
    const { userId } = getFilterContext(context);

    const id = await saveKnowledge(agentId, content, 'mca-tool', category, {
      confidence,
      userId,
    });

    return {
      success: true,
      message: `Knowledge saved successfully`,
      id,
    };
  },
};
