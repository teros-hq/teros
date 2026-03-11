#!/usr/bin/env bun

/**
 * Teros Boards Manager MCA v1.1 (Read-Write)
 *
 * Provides full management of projects, boards, and tasks for coordinator agents.
 * Only coordinator/manager agents should be granted access to this MCA.
 *
 * Tools:
 * - get-project: Get project details including board columns
 * - list-projects: List all projects in a workspace
 * - get-task: Get detailed information about a specific task
 * - list-tasks: List tasks in a project with optional filters
 * - list-board-agents: List agents with board-manager or board-runner access
 * - create-project: Create a new project with board
 * - create-task: Create a single task
 * - batch-create-tasks: Create multiple tasks at once
 * - update-task: Update task properties
 * - update-task-status: Update semantic status (idle/assigned/working/blocked/review/done)
 * - move-task: Move task between columns
 * - assign-task: Assign/unassign agent to task
 * - start-task: Move to in_progress + create conversation
 * - link-conversation: Link existing conversation to task
 * - add-progress-note: Post a progress update on a task
 * - delete-task: Delete a task
 * - add-task-dependency: Add a dependency between two tasks (with DFS cycle detection)
 * - remove-task-dependency: Remove a dependency between two tasks
 * - get-task-dependencies: Get the dependencies of a task
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { disconnectWsClient, initializeWsClient, isWsConnected } from './lib';
import {
  addProgressNote,
  addTaskDependency,
  assignTask,
  batchCreateTasks,
  createProject,
  createTask,
  deleteTask,
  getProject,
  getTask,
  getTaskDependencies,
  linkConversation,
  listBoardAgents,
  listProjects,
  listTasks,
  moveTask,
  removeTaskDependency,
  startTask,
  updateTask,
  updateTaskStatus,
} from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.teros.board-manager',
  name: 'Boards Manager',
  version: '1.1.0',
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
    const builder = new HealthCheckBuilder().setVersion('1.1.0');

    if (isWsConnected()) {
      builder.addCheck('backend_websocket', true, 'Connected');
    } else {
      builder.addCheck('backend_websocket', false, 'Not connected');
    }

    return builder.build();
  },
});

// =============================================================================
// READ TOOLS
// =============================================================================

server.tool('get-project', getProject);
server.tool('list-projects', listProjects);
server.tool('get-task', getTask);
server.tool('list-tasks', listTasks);
server.tool('list-board-agents', listBoardAgents);

// =============================================================================
// WRITE TOOLS
// =============================================================================

server.tool('create-project', createProject);
server.tool('create-task', createTask);
server.tool('batch-create-tasks', batchCreateTasks);
server.tool('update-task', updateTask);
server.tool('update-task-status', updateTaskStatus);
server.tool('move-task', moveTask);
server.tool('assign-task', assignTask);
server.tool('start-task', startTask);
server.tool('link-conversation', linkConversation);
server.tool('add-progress-note', addProgressNote);
server.tool('delete-task', deleteTask);
server.tool('add-task-dependency', addTaskDependency);
server.tool('remove-task-dependency', removeTaskDependency);
server.tool('get-task-dependencies', getTaskDependencies);

// =============================================================================
// START
// =============================================================================

async function main() {
  console.error('🚀 Starting Boards Manager MCA...');

  // Connect to backend via WebSocket
  await initializeWsClient();

  // Start HTTP server
  await server.start();
  console.error('✅ Boards Manager MCA ready');
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.error('📴 Shutting down Boards Manager MCA...');
  disconnectWsClient();
  process.exit(0);
});

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
