import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminFeatureFlagsSetOverride: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Create or update an override for a feature flag. Overrides apply to a specific user, workspace, or company. Super admin only.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Feature flag key' },
      targetType: { type: 'string', enum: ['user', 'workspace', 'company'], description: 'Scope of the override' },
      targetId: { type: 'string', description: 'ID of the target' },
      value: { description: 'Override value' },
      note: { type: 'string', description: 'Optional note explaining the override' },
    },
    required: ['key', 'targetType', 'targetId', 'value'],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    return adminRequest('admin-api.feature-flags-set-override', args as Record<string, unknown>);
  },
};
