import type { HttpToolConfig } from '@teros/mca-sdk';
import { getRelevantContext, formatContextForPrompt } from '@teros/shared/memory';
import { getAgentId } from '../lib';
import { ensureQdrantInitialized } from '../qdrant-init';

export const memoryGetContextForQuery: HttpToolConfig = {
  description:
    'Get relevant memory context for a user query (what would be injected into the prompt)',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: "The user's query",
      },
    },
    required: ['query'],
  },
  handler: async (args, context) => {
    await ensureQdrantInitialized(context);
    const { query } = args as { query: string };
    const agentId = getAgentId(context);

    const relevantContext = await getRelevantContext(agentId, query);
    const formattedContext = formatContextForPrompt(relevantContext);

    return {
      success: true,
      context: formattedContext || 'No relevant context found in memory',
    };
  },
};
