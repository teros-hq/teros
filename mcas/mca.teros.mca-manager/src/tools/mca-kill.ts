import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib';

export const mcaKill: ToolConfig = {
  description: 'Kill a specific MCA process by appId. The process will be restarted on next use.',
  parameters: {
    type: 'object',
    properties: {
      appId: {
        type: 'string',
        description: "The appId of the MCA to kill (e.g., 'app:mca-teros-bash-system')",
      },
    },
    required: ['appId'],
  },
  handler: async (args) => {
    if (!isWsConnected()) {
      throw new Error('Not connected to backend WebSocket.');
    }

    const appId = args?.appId as string;
    if (!appId) throw new Error('appId is required');

    return adminRequest('admin-api.mca-kill', { appId });
  },
};
