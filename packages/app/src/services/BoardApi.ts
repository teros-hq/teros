/**
 * BoardApi — Typed client for the board domain
 *
 * Replaces the raw legacy board patterns in TerosClient for all project/board/task
 * operations. Uses the WsFramework request/response protocol via WsTransport.
 */

import type { WsTransport } from './WsTransport'

// ============================================================================
// Shared types
// ============================================================================

export interface ProjectData {
  projectId: string
  workspaceId: string
  boardId: string
  name: string
  description?: string
  context?: string
  ownerId: string
  status: string
  createdAt: string
  updatedAt?: string
}

export interface BoardColumn {
  columnId: string
  name: string
  order: number
  color?: string
}

export interface BoardConfig {
  columns: BoardColumn[]
  [key: string]: any
}

export interface BoardData {
  boardId: string
  projectId: string
  config: BoardConfig
  createdAt: string
  updatedAt?: string
}

export interface BoardSummary {
  boardId: string
  columns: Array<{
    columnId: string
    name: string
    taskCount: number
  }>
  totalTasks: number
}

export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low'
export type TaskStatus = 'idle' | 'assigned' | 'working' | 'blocked' | 'review' | 'done'

export interface ProgressNote {
  text: string
  actorId: string
  createdAt: string
}

export interface ActivityEntry {
  type: string
  actorId: string
  timestamp: string
  [key: string]: any
}

export interface TaskData {
  taskId: string
  boardId: string
  columnId: string
  parentTaskId?: string
  title: string
  description?: string
  priority: TaskPriority
  status: TaskStatus
  tags?: string[]
  assignedAgentId?: string
  channelId?: string
  position: number
  progressNotes?: ProgressNote[]
  activity?: ActivityEntry[]
  createdAt: string
  updatedAt?: string
}

export interface AgentInfo {
  agentId: string
  name: string
  fullName?: string
  avatarUrl?: string
}

export interface CreateTaskInput {
  title: string
  description?: string
  priority?: TaskPriority
  tags?: string[]
  columnId?: string
  assignedAgentId?: string
  parentTaskId?: string
}

// ============================================================================
// BoardApi
// ============================================================================

export class BoardApi {
  constructor(private readonly transport: WsTransport) {}

  // --------------------------------------------------------------------------
  // Projects
  // --------------------------------------------------------------------------

  /** Create a new project with its board */
  createProject(
    workspaceId: string,
    name: string,
    description?: string,
  ): Promise<{ project: ProjectData; board: BoardData }> {
    return this.transport.request('board.create-project', {
      workspaceId,
      name,
      ...(description !== undefined ? { description } : {}),
    })
  }

  /** List projects in a workspace */
  listProjects(workspaceId: string): Promise<{ workspaceId: string; projects: ProjectData[] }> {
    return this.transport.request('board.list-projects', { workspaceId })
  }

  /** Get a single project by ID */
  getProject(projectId: string): Promise<{ project: ProjectData }> {
    return this.transport.request('board.get-project', { projectId })
  }

  /** Update project metadata */
  updateProject(
    projectId: string,
    updates: { name?: string; description?: string; context?: string },
  ): Promise<{ project: ProjectData }> {
    return this.transport.request('board.update-project', { projectId, ...updates })
  }

  /** Delete a project (admin/owner only) */
  deleteProject(projectId: string): Promise<{ projectId: string }> {
    return this.transport.request('board.delete-project', { projectId })
  }

  // --------------------------------------------------------------------------
  // Boards
  // --------------------------------------------------------------------------

  /** Get board with tasks and agents for a project */
  getBoard(projectId: string): Promise<{ board: BoardData; tasks: TaskData[]; agents: AgentInfo[] }> {
    return this.transport.request('board.get', { projectId })
  }

  /** Get board summary (task counts per column) */
  getBoardSummary(projectId: string): Promise<{ projectId: string } & BoardSummary> {
    return this.transport.request('board.get-summary', { projectId })
  }

  /** Update board configuration */
  updateBoardConfig(
    projectId: string,
    config: Partial<BoardConfig>,
  ): Promise<{ projectId: string; config: BoardConfig }> {
    return this.transport.request('board.update-config', { projectId, config })
  }

  /** Subscribe session to real-time board events */
  subscribeBoard(boardId: string): Promise<{ boardId: string }> {
    return this.transport.request('board.subscribe', { boardId })
  }

  /** Unsubscribe session from real-time board events */
  unsubscribeBoard(boardId: string): Promise<{ boardId: string }> {
    return this.transport.request('board.unsubscribe', { boardId })
  }

  // --------------------------------------------------------------------------
  // Tasks
  // --------------------------------------------------------------------------

  /** Create a task in a project's board */
  createTask(
    projectId: string,
    input: CreateTaskInput,
  ): Promise<{ task: TaskData }> {
    return this.transport.request('board.create-task', { projectId, ...input })
  }

  /** Create multiple tasks atomically */
  batchCreateTasks(
    projectId: string,
    tasks: CreateTaskInput[],
  ): Promise<{ projectId: string; tasks: TaskData[]; count: number }> {
    return this.transport.request('board.batch-create-tasks', { projectId, tasks })
  }

  /** Get full task details including sub-tasks */
  getTask(taskId: string): Promise<{ task: TaskData; subTasks: TaskData[]; agents: AgentInfo[] }> {
    return this.transport.request('board.get-task', { taskId })
  }

  /** List tasks in a project with optional filters */
  listTasks(
    projectId: string,
    filters?: {
      columnId?: string
      assignedAgentId?: string
      priority?: TaskPriority
      tags?: string[]
    },
  ): Promise<{ projectId: string; tasks: TaskData[]; agents: AgentInfo[] }> {
    return this.transport.request('board.list-tasks', { projectId, ...filters })
  }

  /** Update task properties */
  updateTask(
    taskId: string,
    updates: {
      title?: string
      description?: string
      priority?: TaskPriority
      tags?: string[]
      assignedAgentId?: string | null
    },
  ): Promise<{ task: TaskData }> {
    return this.transport.request('board.update-task', { taskId, ...updates })
  }

  /** Update task status (manager action) */
  updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    actor?: string,
  ): Promise<{ task: TaskData; previousStatus: TaskStatus }> {
    return this.transport.request('board.update-task-status', {
      taskId,
      status,
      ...(actor !== undefined ? { actor } : {}),
    })
  }

  /** Move a task to a different column */
  moveTask(
    taskId: string,
    columnId: string,
    position?: number,
  ): Promise<{ task: TaskData }> {
    return this.transport.request('board.move-task', {
      taskId,
      columnId,
      ...(position !== undefined ? { position } : {}),
    })
  }

  /** Assign or unassign an agent to a task */
  assignTask(
    taskId: string,
    agentId?: string | null,
  ): Promise<{ task: TaskData }> {
    return this.transport.request('board.assign-task', { taskId, agentId })
  }

  /** Start a task: move to in_progress, create/reuse channel, send initial message */
  startTask(
    taskId: string,
    agentId?: string,
    prompt?: string,
  ): Promise<{ task: TaskData; channelId: string }> {
    return this.transport.request('board.start-task', {
      taskId,
      ...(agentId !== undefined ? { agentId } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
    })
  }

  /** Link an existing channel to a task */
  linkConversation(taskId: string, channelId: string): Promise<{ task: TaskData }> {
    return this.transport.request('board.link-conversation', { taskId, channelId })
  }

  /** Delete a task from the board */
  deleteTask(taskId: string): Promise<{ taskId: string }> {
    return this.transport.request('board.delete-task', { taskId })
  }

  /** Add a progress note to a task (manager action) */
  addProgressNote(taskId: string, text: string, actor?: string): Promise<{ task: TaskData }> {
    return this.transport.request('board.add-progress-note', {
      taskId,
      text,
      ...(actor !== undefined ? { actor } : {}),
    })
  }

  /** Get all tasks assigned to a specific agent in a workspace */
  getTasksByAgent(
    workspaceId: string,
    agentId: string,
  ): Promise<{ agentId: string; tasks: TaskData[] }> {
    return this.transport.request('board.get-tasks-by-agent', { workspaceId, agentId })
  }

  /** Get the task linked to a channel (null if none) */
  getTaskByChannel(channelId: string): Promise<{ channelId: string; task: TaskData | null }> {
    return this.transport.request('board.get-task-by-channel', { channelId })
  }

  // --------------------------------------------------------------------------
  // Runner commands (ownership-validated — only for the assigned agent)
  // --------------------------------------------------------------------------

  /** Move a task assigned to the calling agent */
  moveMyTask(
    taskId: string,
    columnId: string,
    agentId: string,
    position?: number,
  ): Promise<{ task: TaskData }> {
    return this.transport.request('board.move-my-task', {
      taskId,
      columnId,
      agentId,
      ...(position !== undefined ? { position } : {}),
    })
  }

  /** Update status of a task assigned to the calling agent */
  updateMyTaskStatus(
    taskId: string,
    status: TaskStatus,
    agentId: string,
  ): Promise<{ task: TaskData; previousStatus: TaskStatus }> {
    return this.transport.request('board.update-my-task-status', { taskId, status, agentId })
  }

  /** Add a progress note to a task assigned to the calling agent */
  addMyProgressNote(
    taskId: string,
    text: string,
    agentId: string,
  ): Promise<{ task: TaskData }> {
    return this.transport.request('board.add-my-progress-note', { taskId, text, agentId })
  }
}
