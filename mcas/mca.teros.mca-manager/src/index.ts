#!/usr/bin/env bun

/**
 * MCA Manager MCA v2.0
 *
 * Monitor and manage MCA processes. View running MCAs, kill processes,
 * cleanup inactive, and manage app access.
 *
 * Transport: WebSocket (admin_request via WsRouter admin-api domain)
 * No longer requires ADMIN_API_URL / ADMIN_API_KEY secrets.
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import {
  adminRequest,
  disconnectWsClient,
  initializeWsClient,
  isWsConnected,
} from './lib';
import { agentAccessList, appsList, catalogList, mcaCleanup, mcaKill, mcaStatus } from './tools';

// =============================================================================
// CONFIGURATION
// =============================================================================

const MCA_APP_ID = process.env.MCA_APP_ID || 'unknown';
const MCA_APP_NAME = process.env.MCA_APP_NAME || 'mca-manager';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.teros.mca-manager',
  name: 'MCA Manager',
  version: '2.0.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies WebSocket connectivity to backend.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    const builder = new HealthCheckBuilder({}).setVersion('2.0.0');

    if (!isWsConnected()) {
      builder.addIssue('DEPENDENCY_UNAVAILABLE', 'Not connected to backend WebSocket', {
        type: 'auto_retry',
        description: 'WebSocket connection to backend is not established',
      });
      return builder.build();
    }

    // Validate connectivity by making a lightweight admin request
    try {
      await adminRequest('admin-api.mca-status');
    } catch (error: any) {
      builder.addIssue('DEPENDENCY_UNAVAILABLE', `Admin API error: ${error.message}`, {
        type: 'auto_retry',
        description: 'Admin API temporarily unavailable via WebSocket',
      });
    }

    return builder.build();
  },
});

// =============================================================================
// REGISTER TOOLS
// =============================================================================

server.tool('mca-status', mcaStatus);
server.tool('mca-kill', mcaKill);
server.tool('mca-cleanup', mcaCleanup);
server.tool('apps-list', appsList);
server.tool('agent-access-list', agentAccessList);
server.tool('catalog-list', catalogList);

// =============================================================================
// START SERVER
// =============================================================================

async function main() {
  console.error(`🔧 MCA Manager starting (appId: ${MCA_APP_ID}, name: ${MCA_APP_NAME})`);

  // Initialize WebSocket connection (core transport)
  await initializeWsClient();

  if (isWsConnected()) {
    console.error('✅ Connected to backend via WebSocket');
  } else {
    console.error('⚠️ WebSocket connection failed — health check will report DEPENDENCY_UNAVAILABLE');
  }

  // Start the MCA server
  await server.start();
  console.error('🔗 MCA Manager MCA running');
}

main().catch((error) => {
  console.error('[MCA Manager] Fatal error:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.error('👋 Shutting down MCA Manager...');
  disconnectWsClient();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('👋 Shutting down MCA Manager...');
  disconnectWsClient();
  process.exit(0);
});
