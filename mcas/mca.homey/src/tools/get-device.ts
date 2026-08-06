import type { ToolConfig } from '@teros/mca-sdk';
import { getHomeyApi, getSecrets, getZones, withTokenRefresh } from '../lib';

export const getDevice: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get detailed information and current state of a specific Homey device by ID',
  parameters: {
    type: 'object',
    properties: {
      device_id: {
        type: 'string',
        description: 'Device ID',
      },
    },
    required: ['device_id'],
  },
  handler: async (args, context) => {
    const secrets = await getSecrets(context);

    return withTokenRefresh(secrets, context, async (sec) => {
      const api = await getHomeyApi(sec);
      const device = await api.devices.getDevice({ id: args.device_id as string });
      const zones = await getZones(sec);
      const zone = device.zone ? zones[device.zone] : null;

      return JSON.stringify(
        {
          ...device,
          zoneName: zone?.name || 'No Zone',
        },
        null,
        2,
      );
    });
  },
};
