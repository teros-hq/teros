import type { ToolConfig } from '@teros/mca-sdk';

export const appInstall: ToolConfig = {
  description: 'Install an MCA from the catalog as an app.',
  parameters: {
    type: 'object',
    properties: {
      mcaId: {
        type: 'string',
        description: "The MCA ID to install (e.g., 'mca.teros.bash')",
      },
      name: {
        type: 'string',
        description: 'Optional: Custom name for the app. Auto-generated if not provided.',
      },
      workspaceId: {
        type: 'string',
        description: 'Optional: Install in a workspace. If not provided, installs as a user app.',
      },
    },
    required: ['mcaId'],
  },
  handler: async (args, context) => {
    return context.appInstall(
      args.mcaId as string,
      args.name as string | undefined,
      args.workspaceId as string | undefined,
    );
  },
};
