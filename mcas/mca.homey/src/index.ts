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
import { initHomeyApi, invalidateAllCaches, type HomeySecrets } from './lib';
import {
  // Devices
  getDevice,
  listDevices,
  setCapability,
  // Flows
  listFlows,
  triggerFlow,
  // Zones
  listZones,
  // System
  getSystemInfo,
  // User
  getUser,
  // Notifications
  listNotifications,
  // Variables
  getVariables,
  setVariable,
  // Apps
  listApps,
  // Energy
  getEnergy,
} from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.homey',
  name: 'Homey',
  version: '1.0.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

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
        invalidateAllCaches(); // Force re-init on health check
        const api = await initHomeyApi(secrets);
        const user = await api.users.getUsers();
        // API responded successfully — no issues means build() returns 'ready'
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

// =============================================================================
// REGISTER TOOLS: USER
// =============================================================================

server.tool('homey-get-user', getUser);

// =============================================================================
// REGISTER TOOLS: DEVICES
// =============================================================================

server.tool('homey-list-devices', listDevices);
server.tool('homey-get-device', getDevice);
server.tool('homey-set-capability', setCapability);

// =============================================================================
// REGISTER TOOLS: FLOWS
// =============================================================================

server.tool('homey-list-flows', listFlows);
server.tool('homey-trigger-flow', triggerFlow);

// =============================================================================
// REGISTER TOOLS: ZONES
// =============================================================================

server.tool('homey-list-zones', listZones);

// =============================================================================
// REGISTER TOOLS: SYSTEM
// =============================================================================

server.tool('homey-get-system-info', getSystemInfo);

// =============================================================================
// REGISTER TOOLS: NOTIFICATIONS
// =============================================================================

server.tool('homey-list-notifications', listNotifications);

// =============================================================================
// REGISTER TOOLS: VARIABLES
// =============================================================================

server.tool('homey-get-variables', getVariables);
server.tool('homey-set-variable', setVariable);

// =============================================================================
// REGISTER TOOLS: APPS
// =============================================================================

server.tool('homey-list-apps', listApps);

// =============================================================================
// REGISTER TOOLS: ENERGY
// =============================================================================

server.tool('homey-get-energy', getEnergy);

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
