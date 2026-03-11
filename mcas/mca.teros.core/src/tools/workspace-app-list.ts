import type { ToolConfig } from '@teros/mca-sdk';

export const workspaceAppList: ToolConfig = {
  description: 'List apps in a workspace.',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description: 'The workspace ID to list apps for',
      },
    },
    required: ['workspaceId'],
  },
  handler: async (args, context) => {
    const { workspaceId } = args;
    return context.workspaceAppList(workspaceId as string);
  },
};
