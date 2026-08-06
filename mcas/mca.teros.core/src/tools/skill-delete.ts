import type { ToolConfig } from '@teros/mca-sdk';

export const skillDelete: ToolConfig = {
  annotations: { readOnlyHint: false, irreversible: true },
  description: 'Delete a skill and all its agent access entries.',
  parameters: {
    type: 'object',
    properties: {
      skillId: {
        type: 'string',
        description: 'The skill ID to delete',
      },
    },
    required: ['skillId'],
  },
  handler: async (args, context) => {
    return context.skillDelete(args.skillId as string);
  },
};
