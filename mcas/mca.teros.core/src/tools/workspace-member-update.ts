import type { ToolConfig } from '@teros/mca-sdk';

export const workspaceMemberUpdate: ToolConfig = {
  description: "Update a member's role in a workspace.",
  parameters: {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description: 'The workspace ID',
      },
      userId: {
        type: 'string',
        description: 'The user ID',
      },
      role: {
        type: 'string',
        enum: ['admin', 'write', 'read'],
        description: 'New role for the member',
      },
    },
    required: ['workspaceId', 'userId', 'role'],
  },
  handler: async (args, context) => {
    return context.workspaceMemberUpdate(
      args.workspaceId as string,
      args.userId as string,
      args.role as string,
    );
  },
};
