import type { ToolConfig } from '@teros/mca-sdk';

export const agentCreate: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a new agent instance. The core is assigned automatically by scope (no workspace → super-agent; workspace → agent).',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: "Short name for the agent (e.g., 'Alice')",
      },
      fullName: {
        type: 'string',
        description: "Full name for the agent (e.g., 'Alice Evergreen')",
      },
      role: {
        type: 'string',
        description: "Role description (e.g., 'Personal Assistant')",
      },
      intro: {
        type: 'string',
        description: 'Introduction text for the agent',
      },
      workspaceId: {
        type: 'string',
        description:
          'Optional: Workspace ID to create the agent in. If not provided, creates a global agent. Pass null explicitly to create a Superagent (a global agent with elevated capabilities not bound to any workspace).',
      },
    },
    required: ['name', 'fullName', 'role', 'intro'],
  },
  handler: async (args, context) => {
    return context.agentCreate({
      name: args.name as string,
      fullName: args.fullName as string,
      role: args.role as string,
      intro: args.intro as string,
      workspaceId: args.workspaceId as string | undefined,
    });
  },
};
