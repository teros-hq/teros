import type { ToolConfig } from '@teros/mca-sdk';
import { validateAgentId } from './utils';

export const skillSetEnabled: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Enable or disable a skill for a specific agent.',
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'The agent ID',
      },
      skillId: {
        type: 'string',
        description: 'The skill ID',
      },
      enabled: {
        type: 'boolean',
        description: 'Whether to enable (true) or disable (false) the skill for the agent',
      },
    },
    required: ['agentId', 'skillId', 'enabled'],
  },
  handler: async (args, context) => {
    const agentId = args.agentId as string;
    await validateAgentId(agentId, context);
    return context.skillSetEnabled(agentId, args.skillId as string, args.enabled as boolean);
  },
};
