import type { ToolConfig } from '@teros/mca-sdk';

export const appUninstall: ToolConfig = {
  // @todo pablo - 2026.09.30 : re-add alwaysAsk: true once the reason for
  // unlocking is resolved — uninstall is destructive (removes all agent
  // access grants) and should not run silently under allow-all.
  annotations: { readOnlyHint: false },
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
