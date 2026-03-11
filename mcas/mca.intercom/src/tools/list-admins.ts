import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { intercomRequest } from '../lib';

export const listAdmins: ToolConfig = {
  description: 'List all admins (agents) in the Intercom workspace with their IDs, names, emails, and seat status.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const result = (await intercomRequest(context, '/admins')) as Record<string, unknown>;
    const admins = (result.admins as any[]) ?? [];
    return {
      count: admins.length,
      admins: admins.map((a) => ({
        id: a.id,
        name: a.name,
        email: a.email,
        hasInboxSeat: a.has_inbox_seat,
        type: a.type,
      })),
    };
  },
};
