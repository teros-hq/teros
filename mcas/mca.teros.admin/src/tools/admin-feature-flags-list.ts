import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminFeatureFlagsList: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'List all registered feature flags with their DB defaults and override counts. Super admin only.',
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async () => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.feature-flags-list');
  },
};
