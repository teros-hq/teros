import type { ToolConfig } from '@teros/mca-sdk';
import { getHomeyApi, getSecrets, getZones, withTokenRefresh } from '../lib';

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

      // Also get devices to count per zone
      const api = await getHomeyApi(sec);
      const devices = await api.devices.getDevices();
      const deviceCountByZone: Record<string, number> = {};
      for (const device of Object.values(devices) as any[]) {
        if (device.zone) {
          deviceCountByZone[device.zone] = (deviceCountByZone[device.zone] || 0) + 1;
        }
      }

      const zoneList = Object.values(zones).map((zone: any) => ({
        id: zone.id,
        name: zone.name,
        parent: zone.parent,
        icon: zone.icon,
        deviceCount: deviceCountByZone[zone.id] || 0,
      }));

      return JSON.stringify(zoneList, null, 2);
    });
  },
};
