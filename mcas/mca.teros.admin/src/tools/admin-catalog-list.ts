import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminCatalogList: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'List all available MCAs in the catalog. Super admin only.',
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async () => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.catalog-list');
  },
};
