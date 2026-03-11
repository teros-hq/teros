import type { ToolConfig } from '@teros/mca-sdk';

export const appUninstall: ToolConfig = {
  description: 'Uninstall an app. This also removes all agent access grants.',
  parameters: {
    type: 'object',
    properties: {
      appId: {
        type: 'string',
        description: 'The app ID to uninstall',
      },
    },
    required: ['appId'],
  },
  handler: async (args, context) => {
    const appId = args.appId as string;
    return context.appUninstall(appId);
  },
};
