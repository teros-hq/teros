import type { ToolConfig } from '@teros/mca-sdk';

export const appRename: ToolConfig = {
  description: 'Rename an installed app.',
  parameters: {
    type: 'object',
    properties: {
      appId: {
        type: 'string',
        description: 'The app ID to rename',
      },
      name: {
        type: 'string',
        description: 'New name for the app (lower-kebab-case)',
      },
    },
    required: ['appId', 'name'],
  },
  handler: async (args, context) => {
    return context.appRename(args.appId as string, args.name as string);
  },
};
