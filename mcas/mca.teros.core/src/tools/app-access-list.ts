import type { ToolConfig } from '@teros/mca-sdk';

export const appAccessList: ToolConfig = {
  description: 'List all agents that have access to an app.',
  parameters: {
    type: 'object',
    properties: {
      appId: {
        type: 'string',
        description: 'The app ID',
      },
    },
    required: ['appId'],
  },
  handler: async (args, context) => {
    const appId = args.appId as string;
    return context.appAccessList(appId);
  },
};
