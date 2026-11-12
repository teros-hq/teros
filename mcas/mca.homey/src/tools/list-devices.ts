import type { ToolConfig } from '@teros/mca-sdk';
import { getHomeyApi, getSecrets, getZones, withTokenRefresh } from '../lib';

export const listDevices: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List all devices connected to Homey with their zone, class, capabilities, and availability status',
  parameters: {
    type: 'object',
    properties: {
      detailed: {
        type: 'boolean',
        description:
          'Include full capabilitiesObj with values, timestamps, etc. Default: false (compact mode).',
      },
      zone: {
        type: 'string',
        description: 'Filter by zone name (case-insensitive substring match) or zone ID.',
      },
      class: {
        type: 'string',
        description:
          'Filter by device class (e.g. "windowcoverings", "sensor", "light", "socket").',
      },
      capability: {
        type: 'string',
        description:
          'Filter to devices that have this capability (e.g. "windowcoverings_set", "onoff", "dim").',
      },
      available: {
        type: 'boolean',
        description: 'Filter by availability: true = only available devices, false = only unavailable.',
      },
      search: {
        type: 'string',
        description: 'Search device names (case-insensitive substring).',
      },
      limit: {
        type: 'number',
        description: 'Max devices to return (default 200).',
      },
      offset: {
        type: 'number',
        description: 'Skip first N devices for pagination (default 0).',
      },
    },
  },
  handler: async (args, context) => {
    const secrets = await getSecrets(context);

    return withTokenRefresh(secrets, context, async (sec) => {
      const api = await getHomeyApi(sec);
      const devices = await api.devices.getDevices();
      const zones = await getZones(sec);

      const detailed = args.detailed === true;
      const offset = typeof args.offset === 'number' ? args.offset : 0;
      const limit = typeof args.limit === 'number' ? args.limit : 200;

      // Build device list with zone names resolved
      let deviceList = Object.values(devices).map((device: any) => {
        const zone = device.zone ? zones[device.zone] : null;
        const zoneName = zone?.name || 'No Zone';
        const base: Record<string, any> = {
          id: device.id,
          name: device.name,
          zoneName,
          zoneId: device.zone,
          class: device.class,
          capabilities: device.capabilities,
          available: device.available,
          ready: device.ready,
        };
        if (detailed) {
          base.capabilitiesObj = device.capabilitiesObj;
        }
        return base;
      });

      // Apply filters in order
      // 1. zone — match if zoneName includes the search string (case-insensitive) OR zoneId equals it exactly
      if (args.zone) {
        const zoneLower = String(args.zone).toLowerCase();
        deviceList = deviceList.filter(
          (d) =>
            d.zoneName.toLowerCase().includes(zoneLower) ||
            d.zoneId === args.zone,
        );
      }

      // 2. class — exact match on device.class (case-insensitive)
      if (args.class) {
        const classLower = String(args.class).toLowerCase();
        deviceList = deviceList.filter((d) => d.class?.toLowerCase() === classLower);
      }

      // 3. capability — device.capabilities array includes the capability name
      if (args.capability) {
        deviceList = deviceList.filter((d) =>
          Array.isArray(d.capabilities) && d.capabilities.includes(args.capability),
        );
      }

      // 4. available — device.available === available
      if (typeof args.available === 'boolean') {
        deviceList = deviceList.filter((d) => d.available === args.available);
      }

      // 5. search — device.name includes search string (case-insensitive)
      if (args.search) {
        const searchLower = String(args.search).toLowerCase();
        deviceList = deviceList.filter((d) =>
          d.name?.toLowerCase().includes(searchLower),
        );
      }

      // Pagination
      const total = deviceList.length;
      const paginated = deviceList.slice(offset, offset + limit);

      const result = {
        total,
        returned: paginated.length,
        offset,
        limit,
        devices: paginated,
      };

      return JSON.stringify(result, null, 2);
    });
  },
};
