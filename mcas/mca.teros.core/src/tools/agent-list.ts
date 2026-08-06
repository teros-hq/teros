import type { ToolConfig } from '@teros/mca-sdk';

export const agentList: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List agents owned by the user or in their workspaces.',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description:
          'Optional: Filter agents by workspace ID. If not provided, lists all accessible agents.',
      },
    },
  },
  handler: async (args, context) => {
    // Use explicitly provided workspaceId, or fall back to the agent's current workspace context
    const workspaceId =
      (args.workspaceId as string | undefined) ?? context.execution.workspaceId;
    const data = await context.agentList(workspaceId);
    return data;
  },
};
