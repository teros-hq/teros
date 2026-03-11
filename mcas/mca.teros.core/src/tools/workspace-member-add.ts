import type { ToolConfig } from '@teros/mca-sdk';

export const workspaceMemberAdd: ToolConfig = {
  description: 'Add a member to a workspace.',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description: 'The workspace ID',
      },
      userId: {
        type: 'string',
        description: 'The user ID to add',
      },
      role: {
        type: 'string',
        enum: ['admin', 'write', 'read'],
        description: 'Role for the member',
      },
    },
    required: ['workspaceId', 'userId', 'role'],
  },
  handler: async (args, context) => {
    return context.workspaceMemberAdd(
      args.workspaceId as string,
      args.userId as string,
      args.role as string,
    );
  },
};
