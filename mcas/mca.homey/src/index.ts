#!/usr/bin/env npx tsx

/**
 * Homey MCA
 *
 * Homey smart home controller using McaServer with HTTP transport.
 * Provides access to devices, flows, zones, and user info via Athom Cloud API.
 *
 * Secrets are fetched on-demand from the backend via callbackUrl:
 *   - System secrets: CLIENT_ID, CLIENT_SECRET
 *   - User secrets:   ACCESS_TOKEN, REFRESH_TOKEN, TOKEN_TYPE, EXPIRES_IN
 *
 * Deployment: per-app (each installed app gets its own process)
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';

// =============================================================================
// TYPES
// =============================================================================

interface HomeySecrets {
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
  ACCESS_TOKEN?: string;
  REFRESH_TOKEN?: string;
  TOKEN_TYPE?: string;
  EXPIRES_IN?: string;
}

// =============================================================================
// HOMEY API FACTORY
// =============================================================================

let homeyApiCache: any = null;
let homeyInstanceCache: any = null;
let zonesCacheData: any = null;

/**
 * Initialize Homey API connection from secrets.
 * Uses lazy caching — reinitializes if secrets change.
 */
async function initHomeyApi(secrets: HomeySecrets) {
  const clientId = secrets.CLIENT_ID;
  const clientSecret = secrets.CLIENT_SECRET;
  const accessToken = secrets.ACCESS_TOKEN;
  const refreshToken = secrets.REFRESH_TOKEN;
  const tokenType = secrets.TOKEN_TYPE || 'bearer';
  const expiresIn = secrets.EXPIRES_IN ? parseInt(secrets.EXPIRES_IN, 10) : 3600;

  if (!clientId || !clientSecret) {
    throw new Error(
      'Homey OAuth credentials not configured. Missing CLIENT_ID or CLIENT_SECRET in system secrets.',
    );
  }

  if (!accessToken || !refreshToken) {
    throw new Error('Homey account not connected. Please connect your Homey account.');
  }

  // Dynamic import — homey-api has no TypeScript definitions
  // @ts-ignore
  const { default: AthomCloudAPI } = await import('homey-api/lib/AthomCloudAPI.js');

  const cloudApi = new AthomCloudAPI({ clientId, clientSecret });

  // Build Token instance and inject it (double underscore is the internal field)
  const Token = AthomCloudAPI.Token;
  const token = new Token({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: tokenType,
    expires_in: expiresIn,
  });
  cloudApi.__token = token;

  // Get authenticated user and first Homey hub
  const user = await cloudApi.getAuthenticatedUser();
  const homey = await user.getFirstHomey();
  homeyInstanceCache = homey;

  // Authenticate to the local Homey instance
  const api = await homey.authenticate();
  homeyApiCache = api;
  zonesCacheData = null; // Reset zones cache on re-auth

  return api;
}

/**
 * Get or initialize Homey API
 */
async function getHomeyApi(secrets: HomeySecrets) {
  if (!homeyApiCache) {
    homeyApiCache = await initHomeyApi(secrets);
  }
  return homeyApiCache;
}

/**
 * Get zones with caching
 */
async function getZones(secrets: HomeySecrets) {
  const api = await getHomeyApi(secrets);
  if (!zonesCacheData) {
    zonesCacheData = await api.zones.getZones();
  }
  return zonesCacheData;
}

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.homey',
  name: 'Homey',
  version: '1.0.0',
});

// -----------------------------------------------------------------------------
// Health Check
// -----------------------------------------------------------------------------

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies Homey API credentials and connectivity.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0');

    try {
      const systemSecrets = await context.getSystemSecrets();
      const userSecrets = await context.getUserSecrets();
      const secrets: HomeySecrets = { ...systemSecrets, ...userSecrets };

      if (!secrets.CLIENT_ID || !secrets.CLIENT_SECRET) {
        builder.addIssue('SYSTEM_CONFIG_MISSING', 'Homey CLIENT_ID or CLIENT_SECRET not configured', {
          type: 'admin_action',
          description: 'Configure CLIENT_ID and CLIENT_SECRET in system secrets',
        });
      } else if (!secrets.ACCESS_TOKEN || !secrets.REFRESH_TOKEN) {
        builder.addIssue('AUTH_REQUIRED', 'Homey account not connected', {
          type: 'user_action',
          description: 'Connect your Homey account via OAuth2',
        });
      } else {
        // Try a real API call to verify connectivity
        homeyApiCache = null; // Force re-init on health check
        const api = await initHomeyApi(secrets);
        const user = await api.users.getUsers();
        builder.setMetadata({ connected: true, userCount: Object.keys(user).length });
      }
    } catch (error) {
      builder.addIssue(
        'CONNECTION_ERROR',
        error instanceof Error ? error.message : 'Failed to connect to Homey',
        {
          type: 'user_action',
          description: 'Verify your Homey is online and credentials are valid',
        },
      );
    }

    return builder.build();
  },
});

// -----------------------------------------------------------------------------
// homey_get_user
// -----------------------------------------------------------------------------

server.tool('homey-get-user', {
  description: 'Get authenticated user information from Homey',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const systemSecrets = await context.getSystemSecrets();
    const userSecrets = await context.getUserSecrets();
    const secrets: HomeySecrets = { ...systemSecrets, ...userSecrets };

    const api = await getHomeyApi(secrets);
    const user = await api.users.getUsers();

    return JSON.stringify(user, null, 2);
  },
});

// -----------------------------------------------------------------------------
// homey_list_devices
// -----------------------------------------------------------------------------

server.tool('homey-list-devices', {
  description: 'List all devices connected to Homey with their zone, class, capabilities, and availability status',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const systemSecrets = await context.getSystemSecrets();
    const userSecrets = await context.getUserSecrets();
    const secrets: HomeySecrets = { ...systemSecrets, ...userSecrets };

    const api = await getHomeyApi(secrets);
    const devices = await api.devices.getDevices();
    const zones = await getZones(secrets);

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
  },
});

// -----------------------------------------------------------------------------
// homey_get_device
// -----------------------------------------------------------------------------

server.tool('homey-get-device', {
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
    const systemSecrets = await context.getSystemSecrets();
    const userSecrets = await context.getUserSecrets();
    const secrets: HomeySecrets = { ...systemSecrets, ...userSecrets };

    const api = await getHomeyApi(secrets);
    const device = await api.devices.getDevice({ id: args.device_id as string });
    const zones = await getZones(secrets);
    const zone = device.zone ? zones[device.zone] : null;

    return JSON.stringify(
      {
        ...device,
        zoneName: zone?.name || 'No Zone',
      },
      null,
      2,
    );
  },
});

// -----------------------------------------------------------------------------
// homey_set_capability
// -----------------------------------------------------------------------------

server.tool('homey-set-capability', {
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
    const systemSecrets = await context.getSystemSecrets();
    const userSecrets = await context.getUserSecrets();
    const secrets: HomeySecrets = { ...systemSecrets, ...userSecrets };

    const api = await getHomeyApi(secrets);
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
  },
});

// -----------------------------------------------------------------------------
// homey_list_flows
// -----------------------------------------------------------------------------

server.tool('homey-list-flows', {
  description: 'List all flows (automations) configured in Homey',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const systemSecrets = await context.getSystemSecrets();
    const userSecrets = await context.getUserSecrets();
    const secrets: HomeySecrets = { ...systemSecrets, ...userSecrets };

    const api = await getHomeyApi(secrets);
    const flows = await api.flow.getFlows();

    const flowList = Object.values(flows).map((flow: any) => ({
      id: flow.id,
      name: flow.name,
      enabled: flow.enabled,
      folder: flow.folder,
    }));

    return JSON.stringify(flowList, null, 2);
  },
});

// -----------------------------------------------------------------------------
// homey_trigger_flow
// -----------------------------------------------------------------------------

server.tool('homey-trigger-flow', {
  description: 'Trigger (run) a Homey flow by its ID',
  parameters: {
    type: 'object',
    properties: {
      flow_id: {
        type: 'string',
        description: 'Flow ID to trigger',
      },
    },
    required: ['flow_id'],
  },
  handler: async (args, context) => {
    const systemSecrets = await context.getSystemSecrets();
    const userSecrets = await context.getUserSecrets();
    const secrets: HomeySecrets = { ...systemSecrets, ...userSecrets };

    const api = await getHomeyApi(secrets);
    const flow = await api.flow.getFlow({ id: args.flow_id as string });
    await flow.trigger();

    return JSON.stringify(
      {
        success: true,
        flow_id: args.flow_id,
        flow_name: flow.name,
        message: 'Flow triggered successfully',
      },
      null,
      2,
    );
  },
});

// -----------------------------------------------------------------------------
// homey_list_zones
// -----------------------------------------------------------------------------

server.tool('homey-list-zones', {
  description: 'List all zones (rooms/areas) configured in Homey',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const systemSecrets = await context.getSystemSecrets();
    const userSecrets = await context.getUserSecrets();
    const secrets: HomeySecrets = { ...systemSecrets, ...userSecrets };

    const zones = await getZones(secrets);

    const zoneList = Object.values(zones).map((zone: any) => ({
      id: zone.id,
      name: zone.name,
      parent: zone.parent,
      icon: zone.icon,
    }));

    return JSON.stringify(zoneList, null, 2);
  },
});

// -----------------------------------------------------------------------------
// homey_rename_device
// -----------------------------------------------------------------------------

server.tool('homey-rename-device', {
  description: 'Rename a Homey device',
  parameters: {
    type: 'object',
    properties: {
      device_id: {
        type: 'string',
        description: 'Device ID',
      },
      name: {
        type: 'string',
        description: 'New name for the device',
      },
    },
    required: ['device_id', 'name'],
  },
  handler: async (args, context) => {
    const systemSecrets = await context.getSystemSecrets();
    const userSecrets = await context.getUserSecrets();
    const secrets: HomeySecrets = { ...systemSecrets, ...userSecrets };

    const api = await getHomeyApi(secrets);
    const device = await api.devices.getDevice({ id: args.device_id as string });
    const oldName = device.name;

    // Get the base URL from the cached Homey instance
    const baseUrl = homeyInstanceCache?._baseUrl;
    if (!baseUrl) {
      throw new Error('Homey instance not initialized. Cannot determine base URL.');
    }

    // Use direct fetch since the SDK does not expose updateDevice properly
    const response = await fetch(`${baseUrl}/api/device/${args.device_id}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${secrets.ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        device: { name: args.name },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to rename device: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const result = await response.json();

    return JSON.stringify(
      {
        success: true,
        device_id: args.device_id,
        old_name: oldName,
        new_name: args.name,
        response: result,
      },
      null,
      2,
    );
  },
});

// =============================================================================
// START SERVER
// =============================================================================

server
  .start()
  .then(() => {
    console.error('🏠 Homey MCA server running');
  })
  .catch((error) => {
    console.error('Failed to start Homey MCA:', error);
    process.exit(1);
  });
