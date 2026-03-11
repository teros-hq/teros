import type { ToolConfig } from '@teros/mca-sdk';

export const providerList: ToolConfig = {
  description:
    'List all LLM providers available to the user. Returns providers with their models, status, and configuration.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (args, context) => {
    return context.providerList();
  },
};
