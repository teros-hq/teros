import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib';

export const catalogList: ToolConfig = {
  description: 'List all MCAs in the catalog (available MCAs that can be installed).',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    if (!isWsConnected()) {
      throw new Error('Not connected to backend WebSocket.');
    }

    return adminRequest('admin-api.catalog-list');
  },
};
