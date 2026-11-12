import type { ToolConfig } from '@teros/mca-sdk';

export const workspaceAppList: ToolConfig = {
  // readOnlyHint fix (annotation bug, 2026-10-01): pure read — lists apps,
  // mutates nothing. Was mis-marked as mutation, so it seeded 'ask' at install.
  annotations: { readOnlyHint: true },
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
