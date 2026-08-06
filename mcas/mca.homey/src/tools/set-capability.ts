import type { ToolConfig } from '@teros/mca-sdk';
import { getHomeyApi, getSecrets, withTokenRefresh } from '../lib';

export const setCapability: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    "Set a device capability value (e.g., turn on/off, set brightness, temperature). Use homey-list-devices to find device IDs and capabilities.",
  parameters: {
    type: 'object',
    properties: {
      device_id: {
        type: 'string',
        description: 'Device ID',
      },
      capability: {
        type: 'string',
        description: "Capability name (e.g., 'onoff', 'dim', 'target_temperature')",
      },
      value: {
        description: 'Value to set (boolean for onoff, number 0-1 for dim, number for temperature)',
      },
    },
    required: ['device_id', 'capability', 'value'],
  },
  handler: async (args, context) => {
    const secrets = await getSecrets(context);

    return withTokenRefresh(secrets, context, async (sec) => {
      const api = await getHomeyApi(sec);
      const device = await api.devices.getDevice({ id: args.device_id as string });

      // Parse value to correct type (HTTP transport may stringify values)
      let parsedValue: any = args.value;
      if (typeof args.value === 'string') {
        if (args.value === 'true') parsedValue = true;
        else if (args.value === 'false') parsedValue = false;
        else if (!isNaN(Number(args.value)) && args.value !== '') parsedValue = Number(args.value);
      }

      await device.setCapabilityValue({
        capabilityId: args.capability as string,
        value: parsedValue,
      });

      return JSON.stringify(
        {
          success: true,
          device_id: args.device_id,
          capability: args.capability,
          value: parsedValue,
          message: `Capability '${args.capability}' set to '${parsedValue}' on device '${device.name}'`,
        },
        null,
        2,
      );
    });
  },
};
