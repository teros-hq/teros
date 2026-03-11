#!/usr/bin/env bun

/**
 * Teros Board Runner MCA v2.0
 *
 * Runner role: limited access scoped to the agent's own assigned tasks.
 * Assign this MCA to worker agents that execute tasks on a board.
 *
 * Tools:
 * - get-my-tasks: Get all tasks assigned to this agent across the workspace
 * - move-my-task: Move one of your assigned tasks to a different column
 * - update-my-task-status: Update the status of one of your assigned tasks
 * - add-progress-note: Add a progress note to one of your assigned tasks
 *                      (prefix with "PROPUESTA: " to suggest new tasks to the manager)
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { disconnectWsClient, initializeWsClient, isWsConnected } from './lib';
import { getMyTasks, moveMyTask, updateMyTaskStatus, addProgressNote } from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.teros.board-runner',
  name: 'Board Runner',
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
    const builder = new HealthCheckBuilder().setVersion('2.0.0');

    if (isWsConnected()) {
      builder.addCheck('backend_websocket', true, 'Connected');
    } else {
      builder.addCheck('backend_websocket', false, 'Not connected');
    }

    return builder.build();
  },
});

// =============================================================================
// RUNNER TOOLS (own tasks only)
// =============================================================================

server.tool('get-my-tasks', getMyTasks);
server.tool('move-my-task', moveMyTask);
server.tool('update-my-task-status', updateMyTaskStatus);
server.tool('add-progress-note', addProgressNote);

// =============================================================================
// START
// =============================================================================

async function main() {
  console.error('🚀 Starting Board Runner MCA...');

  // Connect to backend via WebSocket
  await initializeWsClient();

  // Start HTTP server
  await server.start();
  console.error('✅ Board Runner MCA ready');
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.error('📴 Shutting down Board Runner MCA...');
  disconnectWsClient();
  process.exit(0);
});

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
