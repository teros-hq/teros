import type { ToolConfig } from '@teros/mca-sdk';

export const workspaceGet: ToolConfig = {
  description: 'Get detailed information about a specific workspace.',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description: 'The workspace ID to retrieve',
      },
    },
    required: ['workspaceId'],
  },
  handler: async (args, context) => {
    const workspaceId = args.workspaceId as string;
    return context.workspaceGet(workspaceId);
  },
};
