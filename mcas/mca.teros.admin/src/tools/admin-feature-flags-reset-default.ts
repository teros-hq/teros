import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminFeatureFlagsResetDefault: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Reset a feature flag default value to the code-defined registry default. Super admin only.',
  parameters: {
    type: 'object',
    properties: { key: { type: 'string', description: 'Feature flag key to reset' } },
    required: ['key'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.feature-flags-reset-default', { key: args.key });
  },
};
