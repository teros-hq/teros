import type { ToolConfig } from '@teros/mca-sdk';

export const accessRevoke: ToolConfig = {
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
    return context.accessRevoke(args.agentId as string, args.appId as string);
  },
};
