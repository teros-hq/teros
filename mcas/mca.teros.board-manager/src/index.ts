#!/usr/bin/env bun

/**
 * Teros Boards Manager MCA v1.2 (Read-Write + Supervision)
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
 * - archive-task: Archive or unarchive a task (manager action)
 * - archive-project: Archive a project and all its tasks (manager action)
 * - move-task: Move task between columns
 * - assign-task: Assign/unassign agent to task
 * - start-task: Move to in_progress + create conversation
 * - link-conversation: Link existing conversation to task
 * - add-progress-note: Post a progress update on a task
 * - delete-task: Delete a task
 * - add-task-dependency: Add a dependency between two tasks (with DFS cycle detection)
 * - remove-task-dependency: Remove a dependency between two tasks
 * - get-task-dependencies: Get the dependencies of a task
 * - set-agent-slots: Configure parallel execution slots for an agent (autoplay v2)
 * - set-agent-play: Activate/deactivate autoplay mode for an agent (autoplay v2)
 * --- Board Supervision (Fase 3) ---
 * - subscribe-to-board: Subscribe this conversation to real-time board events
 * - unsubscribe-from-board: Cancel board event subscription
 * - list-board-subscriptions: List active board subscriptions for this conversation
 * - get-board-status: Get operational status of a board (agents, slots, workload)
 * - stop-task: Send a cooperative stop signal to a running task
 * --- Generic Event Subscriptions ---
 * - subscribe-to-events: Subscribe this conversation to MCA events on a topic
 * - unsubscribe-from-events: Delete a channel event subscription
 * - list-event-subscriptions: List active event subscriptions for a channel
 */

import { McaServer, healthIssue, notReady, ready } from '@teros/mca-sdk';
import { disconnectWsClient, initializeWsClient, isWsConnected } from './lib';
import {
  addProgressNote,
  addTaskDependency,
  assignTask,
  batchCreateTasks,
  createProject,
  createTask,
  deleteTask,
  deleteProject,
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
  updateProject,
  updateBoardConfig,
  archiveTask,
  archiveProject,
  setAgentSlots,
  setAgentPlay,
  subscribeToBoard,
  unsubscribeFromBoard,
  listBoardSubscriptions,
  subscribeToEvents,
  unsubscribeFromEvents,
  listEventSubscriptions,
  getBoardStatus,
  stopTask,
} from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.teros.board-manager',
  name: 'Boards Manager',
  version: '1.2.0',
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
    if (isWsConnected()) {
      return ready('1.2.0');
    }
    return notReady(
      healthIssue('DEPENDENCY_UNAVAILABLE', 'Backend WebSocket not connected'),
    );
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
server.tool('archive-task', archiveTask);
server.tool('archive-project', archiveProject);
server.tool('update-project', updateProject);
server.tool('update-board-config', updateBoardConfig);
server.tool('move-task', moveTask);
server.tool('assign-task', assignTask);
server.tool('start-task', startTask);
server.tool('link-conversation', linkConversation);
server.tool('add-progress-note', addProgressNote);
server.tool('delete-task', deleteTask);
server.tool('delete-project', deleteProject);
server.tool('add-task-dependency', addTaskDependency);
server.tool('remove-task-dependency', removeTaskDependency);
server.tool('get-task-dependencies', getTaskDependencies);

// =============================================================================
// AUTOPLAY v2
// =============================================================================

server.tool('set-agent-slots', setAgentSlots);
server.tool('set-agent-play', setAgentPlay);

// =============================================================================
// BOARD SUPERVISION (Fase 3)
// =============================================================================

server.tool('subscribe-to-board', subscribeToBoard);
server.tool('unsubscribe-from-board', unsubscribeFromBoard);
server.tool('list-board-subscriptions', listBoardSubscriptions);
server.tool('get-board-status', getBoardStatus);
server.tool('stop-task', stopTask);

// =============================================================================
// GENERIC EVENT SUBSCRIPTIONS
// =============================================================================

server.tool('subscribe-to-events', subscribeToEvents);
server.tool('unsubscribe-from-events', unsubscribeFromEvents);
server.tool('list-event-subscriptions', listEventSubscriptions);

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
