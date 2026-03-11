import type { ToolConfig } from '@teros/mca-sdk';

export const workspaceCreate: ToolConfig = {
  description: 'Create a new workspace with its own volume.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name for the workspace',
      },
      description: {
        type: 'string',
        description: 'Optional description',
      },
    },
    required: ['name'],
  },
  handler: async (args, context) => {
    return context.workspaceCreate({
      name: args.name as string,
      description: args.description as string | undefined,
    });
  },
};
