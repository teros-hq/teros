import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib';

export const mcaStatus: ToolConfig = {
  description:
    'Get status of all running MCA processes. Shows appId, status, tool count, idle time, and restart count for each MCA.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    if (!isWsConnected()) {
      throw new Error('Not connected to backend WebSocket.');
    }

    return adminRequest('admin-api.mca-status');
  },
};
