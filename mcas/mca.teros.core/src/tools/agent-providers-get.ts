import type { ToolConfig } from '@teros/mca-sdk';

export const agentProvidersGet: ToolConfig = {
  description:
    "Get the LLM provider configuration for an agent. Returns the agent's available providers, preferred provider, and selected model.",
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'The agent ID to query',
      },
    },
    required: ['agentId'],
  },
  handler: async (args, context) => {
    const agentId = args.agentId as string;
    return context.agentProvidersGet(agentId);
  },
};
