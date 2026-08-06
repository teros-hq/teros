import type { ToolConfig } from '@teros/mca-sdk';
import { validateAgentId } from './utils';

export const agentProvidersSet: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Set the available LLM providers for an agent. This determines which providers the agent can use. Requires workspace access or agent ownership.',
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'The agent ID to configure',
      },
      providerIds: {
        type: 'array',
        description: 'Array of provider IDs to make available to this agent',
        items: {
          type: 'string',
        },
      },
    },
    required: ['agentId', 'providerIds'],
  },
  handler: async (args, context) => {
    const agentId = args.agentId as string;
    await validateAgentId(agentId, context);
    const providerIds = args.providerIds as string[];
    return context.agentProvidersSet(agentId, providerIds);
  },
};
