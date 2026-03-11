#!/usr/bin/env bun

/**
 * Teros Admin MCA v2.0
 *
 * Administrative tools for managing the Teros backend.
 *
 * Transport: WebSocket (admin_request via WsRouter admin-api domain)
 * Exception: admin-restart-backend still uses HTTP (see tool for rationale).
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { disconnectWsClient, initializeWsClient, isWsConnected } from './lib/index.js';
import { adminBackendStatus, adminRestartBackend, adminSync } from './tools/index.js';

const MCA_APP_ID = process.env.MCA_APP_ID || 'unknown';
const MCA_APP_NAME = process.env.MCA_APP_NAME || 'teros-admin';

const server = new McaServer({
  id: 'mca.teros.admin',
  name: 'Teros Admin',
  version: '2.0.0',
});

// Health check
server.tool('-health-check', {
  description: 'Internal health check tool. Verifies WebSocket connectivity to backend.',
  parameters: { type: 'object', properties: {} },
  handler: async () => {
    const builder = new HealthCheckBuilder({}).setVersion('2.0.0');

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
server.tool('admin-backend-status', adminBackendStatus);
server.tool('admin-restart-backend', adminRestartBackend);
server.tool('admin-sync', adminSync);

async function main() {
  console.error(`🔧 Teros Admin MCA starting (appId: ${MCA_APP_ID}, name: ${MCA_APP_NAME})`);

  await initializeWsClient();

  if (isWsConnected()) {
    console.error('✅ Connected to backend via WebSocket');
  } else {
    console.error('⚠️ WebSocket connection failed — health check will report DEPENDENCY_UNAVAILABLE');
  }

  await server.start();
  console.error('🔗 Teros Admin MCA running');
}

main().catch((error) => {
  console.error('[Teros Admin] Fatal error:', error);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.error('👋 Shutting down Teros Admin...');
  disconnectWsClient();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('👋 Shutting down Teros Admin...');
  disconnectWsClient();
  process.exit(0);
});
