import type { ToolConfig } from '@teros/mca-sdk';

export const appList: ToolConfig = {
  description: 'List apps owned by the user.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (args, context) => {
    const data = await context.appList();
    return data;
  },
};
