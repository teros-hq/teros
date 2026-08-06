import type { ToolConfig } from '@teros/mca-sdk';
import { validateAgentId } from './utils';

export const skillGrantAccess: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Assign a skill to an agent.',
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'The agent ID to assign the skill to',
      },
      skillId: {
        type: 'string',
        description: 'The skill ID to assign',
      },
    },
    required: ['agentId', 'skillId'],
  },
  handler: async (args, context) => {
    const agentId = args.agentId as string;
    await validateAgentId(agentId, context);
    return context.skillGrantAccess(agentId, args.skillId as string);
  },
};
