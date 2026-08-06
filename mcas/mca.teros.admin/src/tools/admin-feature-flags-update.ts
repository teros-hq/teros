import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminFeatureFlagsUpdate: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Update the default value of a feature flag. Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Feature flag key' },
      defaultValue: { description: 'New default value (boolean, number, or string)' },
    },
    required: ['key', 'defaultValue'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.feature-flags-update', args as Record<string, unknown>);
  },
};
