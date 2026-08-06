import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminFeatureFlagsGetOverrides: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'List all overrides for a specific feature flag. Super admin only.',
  parameters: {
    type: 'object',
    properties: { key: { type: 'string', description: 'Feature flag key' } },
    required: ['key'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.feature-flags-get-overrides', { key: args.key });
  },
};
