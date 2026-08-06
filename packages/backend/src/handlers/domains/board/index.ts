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
 *   board.archive-task          → Archive or unarchive a task (manager action)
 *   board.move-task             → Move a task to a different column
 *   board.assign-task           → Assign or unassign an agent to a task
 *   board.start-task            → Start a task (move to in_progress, create channel, send initial message)
 *   board.link-conversation     → Link an existing channel to a task
 *   board.delete-task           → Delete a task from the board
 *   board.add-progress-note     → Add a progress note to a task (manager action)
 *   board.get-tasks-by-agent    → Get all tasks assigned to a specific agent
 *   board.get-task-by-channel   → Get the task linked to a channel
 *   board.complete-my-task      → Move a task assigned to the calling agent to Review (by slug)
 *   board.block-my-task         → Move a task assigned to the calling agent to Blocked (by slug) + progress note
 *   board.cancel-my-task        → Archive a task assigned to the calling agent in-place + progress note
 *   board.get-my-task           → Get the task linked to the current conversation (singular)
 *   board.add-my-progress-note  → Add a progress note to a task assigned to the calling agent
 *   board.list-board-agents     → List agents with board-manager or board-runner access
 *   board.add-dependency        → Add a dependency between two tasks (with DFS cycle detection)
 *   board.remove-dependency     → Remove a dependency between two tasks
 *   board.set-agent-slots       → Configure parallel execution slots for an agent in a project
 *   board.set-agent-play        → Activate or deactivate autoplay mode for an agent
 */

import type { WsRouter } from '../../../ws-framework/WsRouter'
import type { BoardService } from '../../../services/board-service'
import type { BoardSubscriptionService } from '../../../services/board-subscription-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { SessionManager } from '../../../services/session-manager'
import type { PubSubService } from '../../../services/pubsub-service'
import type { ChannelManager } from '../../../services/channel-manager'
import type { MessageHandler } from '../../message-handler'
import type { EventHandler } from '../../event-handler'
import type { AutoplayService } from '../../../services/autoplay-service'
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
import { createArchiveTaskHandler } from './archive-task'
import { createMoveTaskHandler } from './move-task'
import { createAssignTaskHandler } from './assign-task'
import { createStartTaskHandler } from './start-task'
import { createLinkConversationHandler } from './link-conversation'
import { createDeleteTaskHandler } from './delete-task'
import { createAddProgressNoteHandler } from './add-progress-note'
import { createGetTasksByAgentHandler } from './get-tasks-by-agent'
import { createGetTaskByChannelHandler } from './get-task-by-channel'
import { createCompleteMyTaskHandler } from './complete-my-task'
import { createBlockMyTaskHandler } from './block-my-task'
import { createCancelMyTaskHandler } from './cancel-my-task'
import { createGetMyTaskHandler } from './get-my-task'
import { createMoveMyTaskHandler } from './move-my-task'

import { createAddMyProgressNoteHandler } from './add-my-progress-note'
import { createListBoardAgentsHandler } from './list-board-agents'
import { createAddDependencyHandler } from './add-dependency'
import { createRemoveDependencyHandler } from './remove-dependency'
import { createSetAgentSlotsHandler } from './set-agent-slots'
import { createSetAgentPlayHandler } from './set-agent-play'
import { createRemoveAgentHandler } from './remove-agent'
import { createSubscribeToBoardHandler } from './subscribe-to-board'
import { createUnsubscribeFromBoardHandler } from './unsubscribe-from-board'
import { createListBoardSubscriptionsHandler } from './list-board-subscriptions'
import { createGetBoardStatusHandler } from './get-board-status'
import { createStopTaskHandler } from './stop-task'

export interface BoardDomainDeps {
  boardService: BoardService
  boardSubscriptionService?: BoardSubscriptionService
  workspaceService: WorkspaceService
  sessionManager: SessionManager
  pubSubService: PubSubService
  channelManager: ChannelManager
  messageHandler: MessageHandler
  eventHandler?: EventHandler
  autoplayService: AutoplayService
  db: Db
}

export function register(router: WsRouter, deps: BoardDomainDeps): void {
  const { boardService, boardSubscriptionService, workspaceService, pubSubService, channelManager, messageHandler, eventHandler, autoplayService, db } = deps

  // Projects
  router.register('board.create-project', createCreateProjectHandler(boardService, workspaceService, pubSubService))
  router.register('board.list-projects', createListProjectsHandler(boardService, workspaceService))
  router.register('board.get-project', createGetProjectHandler(boardService, workspaceService))
  router.register('board.update-project', createUpdateProjectHandler(boardService, workspaceService, pubSubService))
  router.register('board.delete-project', createDeleteProjectHandler(boardService, workspaceService, pubSubService))

  // Boards
  router.register('board.get', createGetBoardHandler(boardService, workspaceService, db, autoplayService))
  router.register('board.get-summary', createGetBoardSummaryHandler(boardService, workspaceService))
  router.register('board.update-config', createUpdateBoardConfigHandler(boardService, workspaceService))
  router.register('board.subscribe', createSubscribeBoardHandler(pubSubService))
  router.register('board.unsubscribe', createUnsubscribeBoardHandler(pubSubService))

  // Tasks
  router.register('board.create-task', createCreateTaskHandler(boardService, workspaceService, pubSubService, boardSubscriptionService))
  router.register('board.batch-create-tasks', createBatchCreateTasksHandler(boardService, workspaceService, pubSubService, boardSubscriptionService))
  router.register('board.get-task', createGetTaskHandler(boardService, workspaceService))
  router.register('board.list-tasks', createListTasksHandler(boardService, workspaceService))
  router.register('board.update-task', createUpdateTaskHandler(boardService, workspaceService, pubSubService, boardSubscriptionService))
  router.register('board.archive-task', createArchiveTaskHandler(boardService, workspaceService, pubSubService, autoplayService, boardSubscriptionService))
  router.register('board.move-task', createMoveTaskHandler(boardService, workspaceService, pubSubService, autoplayService, boardSubscriptionService))
  router.register('board.assign-task', createAssignTaskHandler(boardService, workspaceService, pubSubService, autoplayService, boardSubscriptionService))
  router.register('board.start-task', createStartTaskHandler(boardService, workspaceService, pubSubService, channelManager, messageHandler))
  router.register('board.link-conversation', createLinkConversationHandler(boardService, workspaceService, pubSubService))
  router.register('board.delete-task', createDeleteTaskHandler(boardService, workspaceService, pubSubService))
  router.register('board.add-progress-note', createAddProgressNoteHandler(boardService, workspaceService, pubSubService, boardSubscriptionService))
  router.register('board.get-tasks-by-agent', createGetTasksByAgentHandler(boardService, workspaceService))
  router.register('board.get-task-by-channel', createGetTaskByChannelHandler(boardService, channelManager))

  // Runner commands (ownership-validated, semantic — no columnId exposed to runner)
  router.register('board.complete-my-task', createCompleteMyTaskHandler(boardService, workspaceService, pubSubService, autoplayService, boardSubscriptionService, channelManager, eventHandler))
  router.register('board.block-my-task', createBlockMyTaskHandler(boardService, workspaceService, pubSubService, boardSubscriptionService))
  router.register('board.cancel-my-task', createCancelMyTaskHandler(boardService, workspaceService, pubSubService, boardSubscriptionService, eventHandler))
  router.register('board.move-my-task', createMoveMyTaskHandler(boardService, workspaceService, pubSubService, autoplayService, boardSubscriptionService))
  router.register('board.get-my-task', createGetMyTaskHandler(boardService))
  router.register('board.add-my-progress-note', createAddMyProgressNoteHandler(boardService, workspaceService, pubSubService, boardSubscriptionService))

  // Read tools (board-manager MCA)
  router.register('board.list-board-agents', createListBoardAgentsHandler(db, workspaceService))

  // Dependency management
  router.register('board.add-dependency', createAddDependencyHandler(boardService, workspaceService, pubSubService, boardSubscriptionService))
  router.register('board.remove-dependency', createRemoveDependencyHandler(boardService, workspaceService, pubSubService, boardSubscriptionService))

  // Autoplay v2
  router.register('board.set-agent-slots', createSetAgentSlotsHandler(boardService, workspaceService, autoplayService, pubSubService, boardSubscriptionService))
  router.register('board.set-agent-play', createSetAgentPlayHandler(boardService, workspaceService, autoplayService, boardSubscriptionService))
  router.register('board.remove-agent', createRemoveAgentHandler(boardService, workspaceService, autoplayService))

  // Board supervision (Fase 3)
  if (boardSubscriptionService) {
    router.register('board.subscribe-to-board', createSubscribeToBoardHandler(boardService, workspaceService, boardSubscriptionService))
    router.register('board.unsubscribe-from-board', createUnsubscribeFromBoardHandler(boardSubscriptionService))
    router.register('board.list-board-subscriptions', createListBoardSubscriptionsHandler(boardService, boardSubscriptionService))
    router.register('board.get-board-status', createGetBoardStatusHandler(boardService, workspaceService, db))
  }
  // stop-task needs eventHandler to inject messages into the runner's channel
  if (eventHandler) {
    router.register('board.stop-task', createStopTaskHandler(boardService, workspaceService, eventHandler, db, boardSubscriptionService))
  }
}
