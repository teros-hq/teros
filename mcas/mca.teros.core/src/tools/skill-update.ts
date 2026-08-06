import type { ToolConfig } from '@teros/mca-sdk';

export const skillUpdate: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Update an existing skill.',
  parameters: {
    type: 'object',
    properties: {
      skillId: {
        type: 'string',
        description: 'The skill ID to update',
      },
      name: {
        type: 'string',
        description: 'New name for the skill',
      },
      description: {
        type: 'string',
        description: 'New description for the skill',
      },
      content: {
        type: 'string',
        description: 'New Markdown content / instructions for the skill',
      },
    },
    required: ['skillId'],
  },
  handler: async (args, context) => {
    return context.skillUpdate(args.skillId as string, {
      name: args.name as string | undefined,
      description: args.description as string | undefined,
      content: args.content as string | undefined,
    });
  },
};
