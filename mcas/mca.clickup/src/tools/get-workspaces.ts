import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { clickupRequest } from '../lib';

export const getWorkspaces: ToolConfig = {
  description: 'Get all ClickUp workspaces (teams) the user belongs to.',
  parameters: { type: 'object', properties: {} },
  handler: async (_args, context) => {
    const data = await clickupRequest(context, '/team') as { teams: any[] };
    return {
      workspaces: data.teams.map((team) => ({
        id: team.id,
        name: team.name,
        color: team.color,
        avatar: team.avatar,
        memberCount: team.members?.length ?? 0,
      })),
    };
  },
};
