import type { ToolConfig } from '@teros/mca-sdk';

export const appCheckAuth: ToolConfig = {
  description:
    "Check an app's authentication status (connected, expired, missing credentials, not required) without showing anything to the user. Use it to verify auth before or after operating an app. If the status is broken, use show-app-auth so the user can fix it from the chat — never ask for credentials directly.",
  parameters: {
    type: 'object',
    properties: {
      appId: {
        type: 'string',
        description: 'The app whose authentication status to check',
      },
    },
    required: ['appId'],
  },
  annotations: { readOnlyHint: true },
  handler: async (args, context) => {
    return context.appCheckAuth(args.appId as string);
  },
};
