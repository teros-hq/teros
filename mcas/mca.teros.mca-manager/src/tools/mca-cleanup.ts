import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib';

export const mcaCleanup: ToolConfig = {
  description:
    'Trigger cleanup of inactive MCA processes. Kills MCAs that have been idle for too long.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    if (!isWsConnected()) {
      throw new Error('Not connected to backend WebSocket.');
    }

    return adminRequest('admin-api.mca-cleanup');
  },
};
