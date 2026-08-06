#!/usr/bin/env bun

/**
 * Teros Admin Infra MCA v3.0
 *
 * Infrastructure tools for managing the Teros backend:
 * - Backend status, restart, sync
 * - MCA process management (status, kill, cleanup, health)
 *
 * Transport: WebSocket (admin_request via WsRouter admin-api domain)
 * Exception: admin-infra-restart-backend still uses HTTP (see tool for rationale).
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { disconnectWsClient, initializeWsClient, isWsConnected } from './lib/index.js';
import {
  adminInfraBackendStatus,
  adminInfraRestartBackend,
  adminInfraSync,
  adminInfraMcaStatus,
  adminInfraMcaKill,
  adminInfraMcaCleanup,
  adminInfraMcaHealth,
} from './tools/index.js';

const MCA_APP_ID = process.env.MCA_APP_ID || 'unknown';
const MCA_APP_NAME = process.env.MCA_APP_NAME || 'teros-admin-infra';

const server = new McaServer({
  id: 'mca.teros.admin-infra',
  name: 'Teros Admin Infra',
  version: '3.0.0',
});

// Health check
server.tool('-health-check', {
  description: 'Internal health check tool. Verifies WebSocket connectivity to backend.',
  parameters: { type: 'object', properties: {} },
  handler: async () => {
    const builder = new HealthCheckBuilder({}).setVersion('3.0.0');

    if (!isWsConnected()) {
      builder.addIssue('DEPENDENCY_UNAVAILABLE', 'Not connected to backend WebSocket', {
        type: 'auto_retry',
        description: 'WebSocket connection to backend is not established',
      });
    }

    return builder.build();
  },
});

// Register tools
server.tool('admin-infra-backend-status', adminInfraBackendStatus);
server.tool('admin-infra-restart-backend', adminInfraRestartBackend);
server.tool('admin-infra-sync', adminInfraSync);
server.tool('admin-infra-mca-status', adminInfraMcaStatus);
server.tool('admin-infra-mca-kill', adminInfraMcaKill);
server.tool('admin-infra-mca-cleanup', adminInfraMcaCleanup);
server.tool('admin-infra-mca-health', adminInfraMcaHealth);

async function main() {
  console.error(`🔧 Teros Admin Infra MCA starting (appId: ${MCA_APP_ID}, name: ${MCA_APP_NAME})`);

  await initializeWsClient();

  if (isWsConnected()) {
    console.error('✅ Connected to backend via WebSocket');
  } else {
    console.error('⚠️ WebSocket connection failed — health check will report DEPENDENCY_UNAVAILABLE');
  }

  await server.start();
  console.error('🔗 Teros Admin Infra MCA running');
}

main().catch((error) => {
  console.error('[Teros Admin Infra] Fatal error:', error);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.error('👋 Shutting down Teros Admin Infra...');
  disconnectWsClient();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('👋 Shutting down Teros Admin Infra...');
  disconnectWsClient();
  process.exit(0);
});
