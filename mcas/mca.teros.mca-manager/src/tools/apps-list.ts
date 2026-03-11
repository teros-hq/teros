import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib';

export const appsList: ToolConfig = {
  description: 'List all installed apps (MCA instances) with their configuration.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    if (!isWsConnected()) {
      throw new Error('Not connected to backend WebSocket.');
    }

    return adminRequest('admin-api.apps-list');
  },
};
