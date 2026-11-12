import type { ToolConfig } from '@teros/mca-sdk';
import { validateAgentId } from './utils';

export const agentModelReset: ToolConfig = {
  annotations: { readOnlyHint: false, alwaysAsk: true },
  description:
    "Reset an agent's model to System Default by clearing its explicit provider/model pin. " +
    'This is the preferred state: the user\'s default provider/model wins unless there is a ' +
    'considered reason to pin. Broadcasts live to the UI.',
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'The agent ID to reset',
      },
      reason: {
        type: 'string',
        description: 'Why the pin is being cleared. Recorded in the audit log.',
      },
    },
    required: ['agentId'],
  },
  handler: async (args, context) => {
    const agentId = args.agentId as string;
    await validateAgentId(agentId, context);
    return context.agentModelReset(agentId, { reason: args.reason as string | undefined });
  },
};
