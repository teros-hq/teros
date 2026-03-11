import type { ToolConfig } from '@teros/mca-sdk';

export const workspaceList: ToolConfig = {
  description: 'List workspaces the user owns or is a member of.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (args, context) => {
    const data = await context.workspaceList();
    return data;
  },
};
