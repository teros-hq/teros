import type { ToolConfig } from '@teros/mca-sdk';

export const agentUpdate: ToolConfig = {
  description: "Update an existing agent's properties.",
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'The agent ID to update',
      },
      name: {
        type: 'string',
        description: 'New short name',
      },
      fullName: {
        type: 'string',
        description: 'New full name',
      },
      role: {
        type: 'string',
        description: 'New role description',
      },
      intro: {
        type: 'string',
        description: 'New introduction text',
      },
      responseStyle: {
        type: 'string',
        description: "Response style (e.g., 'friendly', 'professional', 'concise')",
      },
      avatarUrl: {
        type: 'string',
        description: 'URL of the agent avatar image',
      },
      context: {
        type: 'string',
        description:
          'Agent-specific context that gets injected into the system prompt. Use this to provide agent-specific instructions, guidelines, or knowledge. Supports markdown.',
      },
    },
    required: ['agentId'],
  },
  handler: async (args, context) => {
    const agentId = args.agentId as string;
    return context.agentUpdate(agentId, {
      name: args.name as string | undefined,
      fullName: args.fullName as string | undefined,
      role: args.role as string | undefined,
      intro: args.intro as string | undefined,
      responseStyle: args.responseStyle as string | undefined,
      avatarUrl: args.avatarUrl as string | undefined,
      context: args.context as string | undefined,
    });
  },
};
