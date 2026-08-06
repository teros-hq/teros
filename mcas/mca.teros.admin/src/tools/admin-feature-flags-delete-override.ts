import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminFeatureFlagsDeleteOverride: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Delete an existing override for a feature flag. Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Feature flag key' },
      targetType: { type: 'string', enum: ['user', 'workspace', 'company'], description: 'Scope of the override to delete' },
      targetId: { type: 'string', description: 'ID of the target' },
    },
    required: ['key', 'targetType', 'targetId'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.feature-flags-delete-override', args as Record<string, unknown>);
  },
};
