import type { ToolConfig } from '@teros/mca-sdk';
import { validateAgentId } from './utils';

export const skillGetAgentSkills: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Get all skills assigned to an agent.',
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'The agent ID to get skills for',
      },
    },
    required: ['agentId'],
  },
  handler: async (args, context) => {
    const agentId = args.agentId as string;
    await validateAgentId(agentId, context);
    return context.skillGetAgentSkills(agentId);
  },
};
