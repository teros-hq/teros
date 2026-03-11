import type { ToolConfig } from '@teros/mca-sdk';

export const agentAppsList: ToolConfig = {
  description: 'List all apps an agent has access to.',
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'The agent ID',
      },
    },
    required: ['agentId'],
  },
  handler: async (args, context) => {
    const agentId = args.agentId as string;
    return context.agentAppsList(agentId);
  },
};
