import type { ToolConfig } from '@teros/mca-sdk';

export const workspaceMemberRemove: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Remove a member from a workspace.',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description: 'The workspace ID',
      },
      userId: {
        type: 'string',
        description: 'The user ID to remove',
      },
    },
    required: ['workspaceId', 'userId'],
  },
  handler: async (args, context) => {
    return context.workspaceMemberRemove(args.workspaceId as string, args.userId as string);
  },
};
