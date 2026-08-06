import type { ToolConfig } from '@teros/mca-sdk';
import { validateAgentId } from './utils';

export const agentAppsList: ToolConfig = {
  annotations: { readOnlyHint: true },
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
    await validateAgentId(agentId, context);
    return context.agentAppsList(agentId);
  },
};
