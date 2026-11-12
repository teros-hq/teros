import type { ToolConfig } from '@teros/mca-sdk';

export const workspaceAgentList: ToolConfig = {
  // readOnlyHint fix (annotation bug, 2026-10-01): pure read — lists agents,
  // mutates nothing. Was mis-marked as mutation, so it seeded 'ask' at install.
  annotations: { readOnlyHint: true },
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
