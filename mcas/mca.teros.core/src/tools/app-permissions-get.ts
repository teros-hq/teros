import type { ToolConfig } from '@teros/mca-sdk';

export const appPermissionsGet: ToolConfig = {
  description:
    "Get the tool permissions of an app: each tool's configured permission ('allow' runs without asking, 'ask' requires user confirmation, 'forbid' is blocked), its manifest flags (readOnly, alwaysAsk), and a summary.",
  parameters: {
    type: 'object',
    properties: {
      appId: {
        type: 'string',
        description: 'The app whose permissions to read',
      },
    },
    required: ['appId'],
  },
  annotations: { readOnlyHint: true },
  handler: async (args, context) => {
    return context.appPermissionsGet(args.appId as string);
  },
};
