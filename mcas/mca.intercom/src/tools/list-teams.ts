import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { intercomRequest } from '../lib';

export const listTeams: ToolConfig = {
  description: 'List all teams in the Intercom workspace with their IDs, names, and member counts.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const result = (await intercomRequest(context, '/teams')) as Record<string, unknown>;
    const teams = (result.teams as any[]) ?? [];
    return {
      count: teams.length,
      teams: teams.map((t) => ({
        id: t.id,
        name: t.name,
        adminIds: t.admin_ids ?? [],
        memberCount: (t.admin_ids ?? []).length,
      })),
    };
  },
};
