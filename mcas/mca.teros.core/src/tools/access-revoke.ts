import type { ToolConfig } from '@teros/mca-sdk';
import { validateAgentId } from './utils';

export const accessRevoke: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: "Revoke an agent's access to an app.",
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'The agent to revoke access from',
      },
      appId: {
        type: 'string',
        description: 'The app to revoke access to',
      },
    },
    required: ['agentId', 'appId'],
  },
  handler: async (args, context) => {
    const agentId = args.agentId as string;
    await validateAgentId(agentId, context);
    return context.accessRevoke(agentId, args.appId as string);
  },
};
