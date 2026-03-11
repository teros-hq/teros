import type { ToolConfig } from '@teros/mca-sdk';

export const agentCoresList: ToolConfig = {
  description: 'List all available agent cores (base personalities/engines).',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (args, context) => {
    return context.agentCoresList();
  },
};
