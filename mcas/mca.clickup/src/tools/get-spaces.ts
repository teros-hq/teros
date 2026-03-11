import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { clickupRequest } from '../lib';

export const getSpaces: ToolConfig = {
  description: 'Get all spaces in a ClickUp workspace.',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string', description: 'The workspace (team) ID' },
      archived: { type: 'boolean', description: 'Include archived spaces (default: false)' },
    },
    required: ['workspaceId'],
  },
  handler: async (args, context) => {
    const { workspaceId, archived = false } = args as { workspaceId: string; archived?: boolean };
    const data = await clickupRequest(context, `/team/${workspaceId}/space`, {
      params: { archived: String(archived) },
    }) as { spaces: any[] };
    return {
      workspaceId,
      spaces: data.spaces.map((space) => ({
        id: space.id,
        name: space.name,
        color: space.color,
        private: space.private,
        archived: space.archived,
        statuses: space.statuses?.map((s: any) => ({ status: s.status, color: s.color, type: s.type })),
      })),
    };
  },
};
