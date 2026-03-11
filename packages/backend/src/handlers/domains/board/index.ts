/**
 * Board domain — registers all board handlers with the router
 *
 * Actions:
 *   board.create-project        → Create a new project with its board
 *   board.list-projects         → List projects in a workspace
 *   board.get-project           → Get a single project by ID
 *   board.update-project        → Update project metadata
 *   board.delete-project        → Delete a project (admin/owner only)
 *   board.get                   → Get board with tasks and agents for a project
 *   board.get-summary           → Get board summary (task counts per column)
 *   board.update-config         → Update board configuration
 *   board.subscribe             → Subscribe session to real-time board events
 *   board.unsubscribe           → Unsubscribe session from real-time board events
 *   board.create-task           → Create a task in a project's board
 *   board.batch-create-tasks    → Create multiple tasks atomically
 *   board.get-task              → Get full task details including sub-tasks
 *   board.list-tasks            → List tasks with optional filters
 *   board.update-task           → Update task properties
 *   board.update-task-status    → Update task status (manager action)
 *   board.move-task             → Move a task to a different column
 *   board.assign-task           → Assign or unassign an agent to a task
 *   board.start-task            → Start a task (move to in_progress, create channel, send initial message)
 *   board.link-conversation     → Link an existing channel to a task
 *   board.delete-task           → Delete a task from the board
 *   board.add-progress-note     → Add a progress note to a task (manager action)
 *   board.get-tasks-by-agent    → Get all tasks assigned to a specific agent
 *   board.get-task-by-channel   → Get the task linked to a channel
 *   board.move-my-task          → Move a task assigned to the calling agent
 *   board.update-my-task-status → Update status of a task assigned to the calling agent
 *   board.add-my-progress-note  → Add a progress note to a task assigned to the calling agent
 *   board.list-board-agents     → List agents with board-manager or board-runner access
 *   board.add-dependency        → Add a dependency between two tasks (with DFS cycle detection)
 *   board.remove-dependency     → Remove a dependency between two tasks
 */

import type { WsRouter } from '../../../ws-framework/WsRouter'
import type { BoardService } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { SessionManager } from '../../../services/session-manager'
import type { ChannelManager } from '../../../services/channel-manager'
import type { MessageHandler } from '../../message-handler'
import type { Db } from 'mongodb'

import { createCreateProjectHandler } from './create-project'
import { createListProjectsHandler } from './list-projects'
import { createGetProjectHandler } from './get-project'
import { createUpdateProjectHandler } from './update-project'
import { createDeleteProjectHandler } from './delete-project'
import { createGetBoardHandler } from './get-board'
import { createGetBoardSummaryHandler } from './get-board-summary'
import { createUpdateBoardConfigHandler } from './update-board-config'
import { createSubscribeBoardHandler } from './subscribe-board'
import { createUnsubscribeBoardHandler } from './unsubscribe-board'
import { createCreateTaskHandler } from './create-task'
import { createBatchCreateTasksHandler } from './batch-create-tasks'
import { createGetTaskHandler } from './get-task'
import { createListTasksHandler } from './list-tasks'
import { createUpdateTaskHandler } from './update-task'
import { createUpdateTaskStatusHandler } from './update-task-status'
import { createMoveTaskHandler } from './move-task'
import { createAssignTaskHandler } from './assign-task'
import { createStartTaskHandler } from './start-task'
import { createLinkConversationHandler } from './link-conversation'
import { createDeleteTaskHandler } from './delete-task'
import { createAddProgressNoteHandler } from './add-progress-note'
import { createGetTasksByAgentHandler } from './get-tasks-by-agent'
import { createGetTaskByChannelHandler } from './get-task-by-channel'
import { createMoveMyTaskHandler } from './move-my-task'
import { createUpdateMyTaskStatusHandler } from './update-my-task-status'
import { createAddMyProgressNoteHandler } from './add-my-progress-note'
import { createListBoardAgentsHandler } from './list-board-agents'
import { createAddDependencyHandler } from './add-dependency'
import { createRemoveDependencyHandler } from './remove-dependency'

export interface BoardDomainDeps {
  boardService: BoardService
  workspaceService: WorkspaceService
  sessionManager: SessionManager
  channelManager: ChannelManager
  messageHandler: MessageHandler
  db: Db
}

export function register(router: WsRouter, deps: BoardDomainDeps): void {
  const { boardService, workspaceService, sessionManager, channelManager, messageHandler, db } = deps

  // Projects
  router.register('board.create-project', createCreateProjectHandler(boardService, workspaceService))
  router.register('board.list-projects', createListProjectsHandler(boardService, workspaceService))
  router.register('board.get-project', createGetProjectHandler(boardService, workspaceService))
  router.register('board.update-project', createUpdateProjectHandler(boardService, workspaceService))
  router.register('board.delete-project', createDeleteProjectHandler(boardService, workspaceService))

  // Boards
  router.register('board.get', createGetBoardHandler(boardService, workspaceService))
  router.register('board.get-summary', createGetBoardSummaryHandler(boardService, workspaceService))
  router.register('board.update-config', createUpdateBoardConfigHandler(boardService, workspaceService))
  router.register('board.subscribe', createSubscribeBoardHandler(sessionManager))
  router.register('board.unsubscribe', createUnsubscribeBoardHandler(sessionManager))

  // Tasks
  router.register('board.create-task', createCreateTaskHandler(boardService, workspaceService, sessionManager))
  router.register('board.batch-create-tasks', createBatchCreateTasksHandler(boardService, workspaceService, sessionManager))
  router.register('board.get-task', createGetTaskHandler(boardService, workspaceService))
  router.register('board.list-tasks', createListTasksHandler(boardService, workspaceService))
  router.register('board.update-task', createUpdateTaskHandler(boardService, workspaceService, sessionManager))
  router.register('board.update-task-status', createUpdateTaskStatusHandler(boardService, workspaceService, sessionManager))
  router.register('board.move-task', createMoveTaskHandler(boardService, workspaceService, sessionManager))
  router.register('board.assign-task', createAssignTaskHandler(boardService, workspaceService, sessionManager))
  router.register('board.start-task', createStartTaskHandler(boardService, workspaceService, sessionManager, channelManager, messageHandler))
  router.register('board.link-conversation', createLinkConversationHandler(boardService, workspaceService, sessionManager))
  router.register('board.delete-task', createDeleteTaskHandler(boardService, workspaceService, sessionManager))
  router.register('board.add-progress-note', createAddProgressNoteHandler(boardService, workspaceService, sessionManager))
  router.register('board.get-tasks-by-agent', createGetTasksByAgentHandler(boardService, workspaceService))
  router.register('board.get-task-by-channel', createGetTaskByChannelHandler(boardService))

  // Runner commands (ownership-validated)
  router.register('board.move-my-task', createMoveMyTaskHandler(boardService, workspaceService, sessionManager))
  router.register('board.update-my-task-status', createUpdateMyTaskStatusHandler(boardService, workspaceService, sessionManager))
  router.register('board.add-my-progress-note', createAddMyProgressNoteHandler(boardService, workspaceService, sessionManager))

  // Read tools (board-manager MCA)
  router.register('board.list-board-agents', createListBoardAgentsHandler(db, workspaceService))

  // Dependency management
  router.register('board.add-dependency', createAddDependencyHandler(boardService, workspaceService, sessionManager))
  router.register('board.remove-dependency', createRemoveDependencyHandler(boardService, workspaceService, sessionManager))
}
