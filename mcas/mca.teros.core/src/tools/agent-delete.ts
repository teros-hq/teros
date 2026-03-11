import type { ToolConfig } from '@teros/mca-sdk';

export const agentDelete: ToolConfig = {
  description: 'Delete an agent. This also removes all app access grants for the agent.',
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'The agent ID to delete',
      },
    },
    required: ['agentId'],
  },
  handler: async (args, context) => {
    const agentId = args.agentId as string;
    return context.agentDelete(agentId);
  },
};
