import type { ToolConfig } from '@teros/mca-sdk';

export const agentPreferredProviderSet: ToolConfig = {
  description:
    'Set the preferred LLM provider for an agent. The provider must be in the agent\'s available providers list. Pass null to clear the preference.',
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'The agent ID to configure',
      },
      providerId: {
        type: 'string',
        description: 'Provider ID to set as preferred (must be in availableProviders), or null to clear',
      },
    },
    required: ['agentId'],
  },
  handler: async (args, context) => {
    const agentId = args.agentId as string;
    const providerId = args.providerId as string | null | undefined;
    return context.agentPreferredProviderSet(agentId, providerId ?? null);
  },
};
