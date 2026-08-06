import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminFeatureFlagsGet: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Get a single feature flag by key, including its current default value and all overrides. Super admin only.',
  parameters: {
    type: 'object',
    properties: { key: { type: 'string', description: 'Feature flag key' } },
    required: ['key'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.feature-flags-get', { key: args.key });
  },
};
