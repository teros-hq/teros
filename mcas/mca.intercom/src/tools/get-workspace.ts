import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { intercomRequest } from '../lib';

export const getWorkspace: ToolConfig = {
  description:
    'Get information about the connected Intercom workspace: name, region, timezone, and the authenticated admin.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const me = (await intercomRequest(context, '/me')) as Record<string, unknown>;
    return {
      admin: {
        id: me.id,
        name: me.name,
        email: me.email,
      },
      workspace: {
        id: (me.app as any)?.id_code,
        name: (me.app as any)?.name,
        timezone: (me.app as any)?.timezone,
        region: (me.app as any)?.region,
        createdAt: (me.app as any)?.created_at,
      },
    };
  },
};
