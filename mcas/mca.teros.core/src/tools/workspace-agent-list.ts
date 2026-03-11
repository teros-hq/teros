import type { ToolConfig } from '@teros/mca-sdk';

export const workspaceAgentList: ToolConfig = {
  description: 'List agents in a workspace.',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description: 'The workspace ID to list agents for',
      },
    },
    required: ['workspaceId'],
  },
  handler: async (args, context) => {
    const { workspaceId } = args;
    return context.workspaceAgentList(workspaceId as string);
  },
};
