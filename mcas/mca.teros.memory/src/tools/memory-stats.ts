import type { HttpToolConfig } from '@teros/mca-sdk';
import { getAgentId } from '../lib';
import { getAgentMemoryStats } from '@teros/shared/memory/qdrant-client';
import { ensureQdrantInitialized } from '../qdrant-init';

export const memoryStats: HttpToolConfig = {
  description: 'Get memory statistics for the current agent (collection sizes, point counts)',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    await ensureQdrantInitialized(context);
    const agentId = getAgentId(context);
    const stats = await getAgentMemoryStats(agentId);
    
    return {
      success: true,
      stats,
    };
  },
};
