import type { ToolConfig } from '@teros/mca-sdk';
import { validateAgentId } from './utils';

export const agentDelete: ToolConfig = {
  annotations: { readOnlyHint: false, irreversible: true },
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
    await validateAgentId(agentId, context);
    return context.agentDelete(agentId);
  },
};
