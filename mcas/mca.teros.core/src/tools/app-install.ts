import type { ToolConfig } from '@teros/mca-sdk';

export const appInstall: ToolConfig = {
  annotations: { readOnlyHint: false, alwaysAsk: true },
  description:
    "Install an MCA from the catalog as an app. The installed app is auto-granted to the user's superagents. Apps are scoped to a workspace: their tools are only available in conversations of that workspace.",
  parameters: {
    type: 'object',
    properties: {
      mcaId: {
        type: 'string',
        description: "The MCA ID to install (e.g., 'mca.teros.bash')",
      },
      name: {
        type: 'string',
        description: 'Optional: Custom name for the app (lower-kebab-case). Auto-generated if not provided.',
      },
      workspaceId: {
        type: 'string',
        description:
          "Optional: Workspace ID to install the app in. Defaults to the user's Private Workspace. To use the app's tools in the current conversation, install it in the conversation's workspace.",
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
