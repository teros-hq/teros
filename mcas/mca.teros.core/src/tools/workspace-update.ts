import type { ToolConfig } from '@teros/mca-sdk';

export const workspaceUpdate: ToolConfig = {
  description:
    'Update workspace properties including the context that gets injected into agent system prompts.',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description: 'The workspace ID to update',
      },
      name: {
        type: 'string',
        description: 'New name',
      },
      description: {
        type: 'string',
        description: 'New description',
      },
      context: {
        type: 'string',
        description:
          'Context text that gets injected into agent system prompts. Use this to provide project-specific information, guidelines, coding standards, or any other context that agents should know. Supports markdown and can be long (multiple paragraphs).',
      },
    },
    required: ['workspaceId'],
  },
  handler: async (args, context) => {
    const workspaceId = args.workspaceId as string;
    return context.workspaceUpdate(workspaceId, {
      name: args.name as string | undefined,
      description: args.description as string | undefined,
      context: args.context as string | undefined,
    });
  },
};
