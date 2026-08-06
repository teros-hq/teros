#!/usr/bin/env bun

/**
 * Teros Board Runner MCA v3.0
 *
 * Runner role: limited access scoped to the agent's own assigned tasks.
 * Assign this MCA to worker agents that execute tasks on a board.
 *
 * Tools:
 * - get-my-tasks:      Get all tasks assigned to this agent across the workspace
 * - get-my-task:       Get the single task linked to the current conversation (fast path)
 * - complete-my-task:  Move task to Review (done with work, ready for manager review)
 * - block-my-task:     Move task to Blocked + add progress note with reason
 * - cancel-my-task:    Archive task in-place + add progress note with reason
 * - add-progress-note: Add a progress note to one of your assigned tasks
 *                      (prefix with "PROPUESTA: " to suggest new tasks to the manager)
 */

import { McaServer, healthIssue, notReady, ready } from '@teros/mca-sdk';
import { disconnectWsClient, initializeWsClient, isWsConnected } from './lib';
import { getMyTasks, getMyTask, completeMyTask, blockMyTask, cancelMyTask, addProgressNote } from './tools';

/**
 * Cooperative stop protocol contract echoed in the health-check response.
 * Mirrors (post-call) the tool description that the LLM reads pre-call, so
 * the contract is visible to the runner at any point during its turn —
 * covers issue S5 del smoke test (el response del `-health-check` devolvía
 * solo `status + version`). Requiere `notes: z.array(z.string())` en
 * `HealthCheckResultSchema` (shared).
 */
const STOP_PROTOCOL_NOTES = [
  'Cooperative stop protocol: at the start of every turn, call get-my-task to check if stopRequested=true on your active task.',
  'If stopRequested is true: 1) finish only the current atomic step (no new work), 2) add a progress note explaining where you left off, 3) call block-my-task with a reason, 4) do NOT continue with further tool calls after completing steps 1-3.',
] as const;

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
  description: `Internal health check tool. Verifies WebSocket connectivity to backend.

IMPORTANT — Cooperative stop protocol:
At the start of every turn, check if the current task has stopRequested=true by calling get-my-task.
If stopRequested is true on your active task:
1. Finish only the current atomic step (do not start new work).
2. Add a progress note explaining where you left off.
3. Call block-my-task with a reason explaining where you stopped.
4. Do NOT continue with further tool calls after completing steps 1-3.`,
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    if (isWsConnected()) {
      // Attach the cooperative stop protocol as `notes` so the runner sees
      // the contract in the health-check response too (not only in the
      // pre-call tool description).
      return { ...ready('2.0.0'), notes: [...STOP_PROTOCOL_NOTES] };
    }
    return notReady(
      healthIssue('DEPENDENCY_UNAVAILABLE', 'Backend WebSocket not connected'),
    );
  },
});

// =============================================================================
// RUNNER TOOLS (own tasks only)
// =============================================================================

server.tool('get-my-tasks', getMyTasks);
server.tool('get-my-task', getMyTask);
server.tool('complete-my-task', completeMyTask);
server.tool('block-my-task', blockMyTask);
server.tool('cancel-my-task', cancelMyTask);
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
