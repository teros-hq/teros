import type { ToolConfig } from '@teros/mca-sdk';

export const appList: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List apps owned by the user.',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description:
          "Optional: Filter apps by workspace ID. If not provided, lists all apps owned by the user across all workspaces.",
      },
    },
  },
  handler: async (args, context) => {
    const data = await context.appList();
    return data;
  },
};
