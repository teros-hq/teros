import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected, type BackendStatus } from '../lib/index.js';

export const adminBackendStatus: ToolConfig = {
  description:
    'Get current status of the Teros backend including uptime, memory usage, process info, and number of running MCAs.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    if (!isWsConnected()) {
      throw new Error('Not connected to backend WebSocket.');
    }

    return adminRequest<BackendStatus>('admin-api.system-status');
  },
};
