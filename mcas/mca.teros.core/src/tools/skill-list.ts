import type { ToolConfig } from '@teros/mca-sdk';

export const skillList: ToolConfig = {
  // readOnlyHint fix (annotation bug, 2026-10-01): pure read — lists skills,
  // mutates nothing. Was mis-marked as mutation, so it seeded 'ask' at install.
  annotations: { readOnlyHint: true },
  description: 'List all skills in a workspace.',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description: 'The workspace ID to list skills from',
      },
    },
    required: ['workspaceId'],
  },
  handler: async (args, context) => {
    return context.skillList(args.workspaceId as string);
  },
};
