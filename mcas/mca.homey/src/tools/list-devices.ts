import type { ToolConfig } from '@teros/mca-sdk';
import { getHomeyApi, getSecrets, getZones, withTokenRefresh } from '../lib';

export const listDevices: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List all devices connected to Homey with their zone, class, capabilities, and availability status',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const secrets = await getSecrets(context);

    return withTokenRefresh(secrets, context, async (sec) => {
      const api = await getHomeyApi(sec);
      const devices = await api.devices.getDevices();
      const zones = await getZones(sec);

      const deviceList = Object.values(devices).map((device: any) => {
        const zone = device.zone ? zones[device.zone] : null;
        return {
          id: device.id,
          name: device.name,
          zoneName: zone?.name || 'No Zone',
          zoneId: device.zone,
          class: device.class,
          capabilities: device.capabilities,
          capabilitiesObj: device.capabilitiesObj,
          available: device.available,
          ready: device.ready,
        };
      });

      return JSON.stringify(deviceList, null, 2);
    });
  },
};
