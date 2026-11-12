import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { adminRequest, isWsConnected } from '../lib/index.js';

export const adminInfraMcaHealth: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Run health checks on all MCA processes. Super admin only. By default force-spawns dormant (standby) MCAs so the check is real — set forceSpawn:false for a cheap read-only snapshot of already-running MCAs.',
  parameters: {
    type: 'object',
    properties: {
      forceSpawn: {
        type: 'boolean',
        description:
          'Spawn dormant (standby) MCAs before checking them. Default true. With false, dormant MCAs are reported as unknown and are NOT started.',
      },
    },
    required: [],
  },
  handler: async (args) => {
    if (!isWsConnected()) throw new Error('Not connected to backend WebSocket.');
    // Default forceSpawn: true. The old default (false) poisoned the fleet after
    // a backend restart: checkAllHealth(false) cached 'unknown' on every standby
    // MCA, and executeTool then refused to spawn them (MCA_NOT_READY deadlock).
    // Backend handler: admin-api.mca-health reads rawData.forceSpawn.
    return adminRequest('admin-api.mca-health', { forceSpawn: args.forceSpawn !== false });
  },
};
