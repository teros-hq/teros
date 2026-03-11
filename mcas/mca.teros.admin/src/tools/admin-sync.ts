import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected, type SyncResult } from '../lib/index.js';

export const adminSync: ToolConfig = {
  description:
    'Sync MCAs, models, and tools from filesystem to database. Run this after adding or modifying MCAs.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    if (!isWsConnected()) {
      throw new Error('Not connected to backend WebSocket.');
    }

    return adminRequest<SyncResult>('admin-api.system-sync');
  },
};
