import type { ToolConfig } from '@teros/mca-sdk';

export const agentGet: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get detailed information about a specific agent.',
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'The agent ID to retrieve',
      },
    },
    required: ['agentId'],
  },
  handler: async (args, context) => {
    const agentId = args.agentId as string;
    try {
      return await context.agentGet(agentId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Agent not found') || message.includes('404')) {
        throw new Error(
          `Agent ID "${agentId}" is not valid. Use list-agents or workspace-agent-list to find valid agent IDs.`,
        );
      }
      throw error;
    }
  },
};
