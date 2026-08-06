import type { ToolConfig } from '@teros/mca-sdk';
import { getSecrets, getZones, withTokenRefresh } from '../lib';

export const listZones: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List all zones (rooms/areas) configured in Homey',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const secrets = await getSecrets(context);

    return withTokenRefresh(secrets, context, async (sec) => {
      const zones = await getZones(sec);

      const zoneList = Object.values(zones).map((zone: any) => ({
        id: zone.id,
        name: zone.name,
        parent: zone.parent,
        icon: zone.icon,
      }));

      return JSON.stringify(zoneList, null, 2);
    });
  },
};
