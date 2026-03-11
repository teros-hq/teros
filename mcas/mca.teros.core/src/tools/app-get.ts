import type { ToolConfig } from '@teros/mca-sdk';

export const appGet: ToolConfig = {
  description: 'Get detailed information about a specific app.',
  parameters: {
    type: 'object',
    properties: {
      appId: {
        type: 'string',
        description: 'The app ID to retrieve',
      },
    },
    required: ['appId'],
  },
  handler: async (args, context) => {
    const appId = args.appId as string;
    return context.appGet(appId);
  },
};
