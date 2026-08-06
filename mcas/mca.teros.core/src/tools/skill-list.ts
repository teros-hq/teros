import type { ToolConfig } from '@teros/mca-sdk';

export const skillList: ToolConfig = {
  annotations: { readOnlyHint: false },
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
