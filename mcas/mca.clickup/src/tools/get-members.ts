import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { clickupRequest } from '../lib';

export const getMembers: ToolConfig = {
  description: 'Get all members of a ClickUp workspace.',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string', description: 'The workspace (team) ID' },
    },
    required: ['workspaceId'],
  },
  handler: async (args, context) => {
    const { workspaceId } = args as { workspaceId: string };
    const data = await clickupRequest(context, '/team') as { teams: any[] };

    const workspace = data.teams.find((t) => t.id === workspaceId);
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);

    return {
      workspaceId,
      workspaceName: workspace.name,
      memberCount: workspace.members?.length ?? 0,
      members: workspace.members?.map((m: any) => ({
        id: m.user.id,
        username: m.user.username,
        email: m.user.email,
        color: m.user.color,
        role: m.role,
        profilePicture: m.user.profilePicture,
      })),
    };
  },
};
