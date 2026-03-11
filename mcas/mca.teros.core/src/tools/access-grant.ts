import type { ToolConfig } from '@teros/mca-sdk';

export const accessGrant: ToolConfig = {
  description: 'Grant an agent access to an app.',
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'The agent to grant access to',
      },
      appId: {
        type: 'string',
        description: 'The app to grant access to',
      },
    },
    required: ['agentId', 'appId'],
  },
  handler: async (args, context) => {
    return context.accessGrant(args.agentId as string, args.appId as string);
  },
};
