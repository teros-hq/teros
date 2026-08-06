import type { ToolConfig } from '@teros/mca-sdk';
import { validateAgentId } from './utils';

export const skillRevokeAccess: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Remove a skill assignment from an agent.',
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'The agent ID to remove the skill from',
      },
      skillId: {
        type: 'string',
        description: 'The skill ID to remove',
      },
    },
    required: ['agentId', 'skillId'],
  },
  handler: async (args, context) => {
    const agentId = args.agentId as string;
    await validateAgentId(agentId, context);
    return context.skillRevokeAccess(agentId, args.skillId as string);
  },
};
