import type { ToolConfig } from '@teros/mca-sdk';

export const workspaceArchive: ToolConfig = {
  description: 'Archive a workspace (soft delete). Only the owner can archive.',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description: 'The workspace ID to archive',
      },
    },
    required: ['workspaceId'],
  },
  handler: async (args, context) => {
    const workspaceId = args.workspaceId as string;
    return context.workspaceArchive(workspaceId);
  },
};
