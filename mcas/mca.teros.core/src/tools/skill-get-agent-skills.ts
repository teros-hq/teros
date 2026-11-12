import type { ToolConfig } from '@teros/mca-sdk';
import { validateAgentId } from './utils';

export const skillGetAgentSkills: ToolConfig = {
  // readOnlyHint fix (annotation bug, 2026-10-01): pure read — lists an agent's
  // skills, mutates nothing. Was mis-marked as mutation, so it seeded 'ask'.
  annotations: { readOnlyHint: true },
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
