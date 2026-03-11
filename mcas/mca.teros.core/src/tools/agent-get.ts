import type { ToolConfig } from '@teros/mca-sdk';

export const agentGet: ToolConfig = {
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
    return context.agentGet(agentId);
  },
};
