import type { ToolConfig } from '@teros/mca-sdk';

export const skillCreate: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Create a new skill in a workspace.',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description: 'The workspace ID to create the skill in',
      },
      name: {
        type: 'string',
        description: 'Name of the skill',
      },
      description: {
        type: 'string',
        description: 'Optional description of the skill',
      },
      content: {
        type: 'string',
        description: 'Markdown content / instructions for the skill',
      },
    },
    required: ['workspaceId', 'name', 'content'],
  },
  handler: async (args, context) => {
    return context.skillCreate({
      workspaceId: args.workspaceId as string,
      name: args.name as string,
      description: args.description as string | undefined,
      content: args.content as string,
    });
  },
};
