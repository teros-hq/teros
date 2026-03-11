import type { ToolConfig } from '@teros/mca-sdk';

export const agentCreate: ToolConfig = {
  description: 'Create a new agent instance from an agent core.',
  parameters: {
    type: 'object',
    properties: {
      coreId: {
        type: 'string',
        description: "The agent core ID to use (e.g., 'alice', 'iria')",
      },
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
          'Optional: Workspace ID to create the agent in. If not provided, creates a global agent.',
      },
    },
    required: ['coreId', 'name', 'fullName', 'role', 'intro'],
  },
  handler: async (args, context) => {
    return context.agentCreate({
      coreId: args.coreId as string,
      name: args.name as string,
      fullName: args.fullName as string,
      role: args.role as string,
      intro: args.intro as string,
      workspaceId: args.workspaceId as string | undefined,
    });
  },
};
