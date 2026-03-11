/**
 * Board Service
 *
 * Manages projects, boards, and tasks for the Teros Boards system.
 *
 * Hierarchy: Workspace → Project → Board (1:1) → Tasks
 *
 * Each project has exactly one board. Tasks live on boards in columns.
 * Tasks can be assigned to agents and linked to conversations.
 */

import {
  generateBoardId,
  generateColumnId,
  generateProjectId,
  generateTaskId,
} from '@teros/core';
import type { Collection, Db } from 'mongodb';
import type {
  Board,
  BoardColumn,
  ProgressNote,
  Project,
  Task,
  TaskActivityEntry,
  TaskActivityEventType,
  TaskPriority,
  TaskStatus,
} from '../types/database';

// ============================================================================
// DEFAULT COLUMNS
// ============================================================================

const DEFAULT_COLUMNS: Array<{ name: string; slug: string }> = [
  { name: 'Backlog', slug: 'backlog' },
  { name: 'To Do', slug: 'todo' },
  { name: 'In Progress', slug: 'in_progress' },
  { name: 'Review', slug: 'review' },
  { name: 'Done', slug: 'done' },
];

// ============================================================================
// INPUT TYPES
// ============================================================================

export interface CreateProjectInput {
  name: string;
  description?: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: TaskPriority;
  tags?: string[];
  assignedAgentId?: string;
  columnId?: string;
  parentTaskId?: string;
  /** IDs of tasks that block this task. Must belong to the same board. */
  dependencies?: string[];
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  priority?: TaskPriority;
  tags?: string[];
  assignedAgentId?: string | null;
  /** IDs of tasks that block this task. Must belong to the same board. */
  dependencies?: string[];
}

export interface ListTasksFilter {
  columnId?: string;
  assignedAgentId?: string;
  priority?: TaskPriority;
  tags?: string[];
}

// ============================================================================
// BOARD SERVICE
// ============================================================================

export class BoardService {
  private projects: Collection<Project>;
  private boards: Collection<Board>;
  private tasks: Collection<Task>;

  constructor(private db: Db) {
    this.projects = db.collection<Project>('projects');
    this.boards = db.collection<Board>('boards');
    this.tasks = db.collection<Task>('tasks');
  }

  // ==========================================================================
  // INDEXES
  // ==========================================================================

  async ensureIndexes(): Promise<void> {
    // Projects
    await this.projects.createIndex({ projectId: 1 }, { unique: true });
    await this.projects.createIndex({ workspaceId: 1 });
    await this.projects.createIndex({ status: 1 });

    // Boards
    await this.boards.createIndex({ boardId: 1 }, { unique: true });
    await this.boards.createIndex({ projectId: 1 }, { unique: true });

    // Tasks
    await this.tasks.createIndex({ taskId: 1 }, { unique: true });
    await this.tasks.createIndex({ boardId: 1, columnId: 1, position: 1 });
    await this.tasks.createIndex({ boardId: 1, assignedAgentId: 1 });
    await this.tasks.createIndex({ channelId: 1 }, { sparse: true });
    await this.tasks.createIndex({ parentTaskId: 1 }, { sparse: true });

    console.log('[BoardService] Database indexes created');
  }

  // ==========================================================================
  // PROJECTS
  // ==========================================================================

  /**
   * Create a new project with its associated board
   */
  async createProject(
    workspaceId: string,
    createdBy: string,
    input: CreateProjectInput,
  ): Promise<{ project: Project; board: Board }> {
    const now = new Date().toISOString();
    const projectId = generateProjectId();
    const boardId = generateBoardId();

    // Create default columns with IDs
    const columns: BoardColumn[] = DEFAULT_COLUMNS.map((col, index) => ({
      columnId: generateColumnId(),
      name: col.name,
      slug: col.slug,
      position: index,
    }));

    const project: Project = {
      projectId,
      workspaceId,
      name: input.name,
      description: input.description,
      createdBy,
      boardId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    const board: Board = {
      boardId,
      projectId,
      columns,
      createdAt: now,
      updatedAt: now,
    };

    await this.projects.insertOne(project);
    await this.boards.insertOne(board);

    console.log(`[BoardService] Created project ${projectId} with board ${boardId} in workspace ${workspaceId}`);
    return { project, board };
  }

  /**
   * List all active projects in a workspace
   */
  async listProjects(workspaceId: string): Promise<Project[]> {
    return this.projects
      .find({ workspaceId, status: 'active' })
      .sort({ createdAt: -1 })
      .toArray();
  }

  /**
   * Get a project by ID
   */
  async getProject(projectId: string): Promise<Project | null> {
    return this.projects.findOne({ projectId });
  }

  /**
   * Update a project
   */
  async updateProject(
    projectId: string,
    update: { name?: string; description?: string; context?: string },
  ): Promise<Project | null> {
    const result = await this.projects.findOneAndUpdate(
      { projectId },
      { $set: { ...update, updatedAt: new Date().toISOString() } },
      { returnDocument: 'after' },
    );
    return result ?? null;
  }

  /**
   * Delete a project, its board, and all tasks
   * Linked conversations are NOT deleted.
   */
  async deleteProject(projectId: string): Promise<boolean> {
    const project = await this.projects.findOne({ projectId });
    if (!project) return false;

    await this.tasks.deleteMany({ boardId: project.boardId });
    await this.boards.deleteOne({ boardId: project.boardId });
    await this.projects.deleteOne({ projectId });

    console.log(`[BoardService] Deleted project ${projectId} and all associated data`);
    return true;
  }

  // ==========================================================================
  // BOARDS
  // ==========================================================================

  /**
   * Get a board by project ID
   */
  async getBoardByProject(projectId: string): Promise<Board | null> {
    return this.boards.findOne({ projectId });
  }

  /**
   * Get a board by board ID
   */
  async getBoard(boardId: string): Promise<Board | null> {
    return this.boards.findOne({ boardId });
  }

  /**
   * Update board columns (rename, add, remove, reorder)
   */
  async updateColumns(boardId: string, columns: BoardColumn[]): Promise<Board | null> {
    if (columns.length === 0) {
      throw new Error('Board must have at least one column');
    }

    // Ensure positions are sequential
    const normalized = columns.map((col, index) => ({
      ...col,
      position: index,
    }));

    const result = await this.boards.findOneAndUpdate(
      { boardId },
      { $set: { columns: normalized, updatedAt: new Date().toISOString() } },
      { returnDocument: 'after' },
    );
    return result ?? null;
  }

  /**
   * Update board execution config (auto-dispatcher settings)
   */
  async updateBoardConfig(boardId: string, config: any): Promise<Board | null> {
    const result = await this.boards.findOneAndUpdate(
      { boardId },
      { $set: { config, updatedAt: new Date().toISOString() } },
      { returnDocument: 'after' },
    );
    return result ?? null;
  }

  // ==========================================================================
  // TASKS
  // ==========================================================================

  /**
   * Create a single task on a board
   */
  async createTask(
    boardId: string,
    createdBy: string,
    input: CreateTaskInput,
  ): Promise<Task> {
    const board = await this.boards.findOne({ boardId });
    if (!board) throw new Error(`Board ${boardId} not found`);

    // Determine target column
    let columnId = input.columnId;
    if (!columnId) {
      // Default to first column (backlog)
      columnId = board.columns[0]?.columnId;
      if (!columnId) throw new Error('Board has no columns');
    } else {
      // Validate column exists
      const colExists = board.columns.some((c) => c.columnId === columnId);
      if (!colExists) throw new Error(`Column ${columnId} not found on board ${boardId}`);
    }

    // Validate parent task if provided
    if (input.parentTaskId) {
      const parent = await this.tasks.findOne({ taskId: input.parentTaskId, boardId });
      if (!parent) throw new Error(`Parent task ${input.parentTaskId} not found on board ${boardId}`);
    }

    // Validate dependencies task IDs — all must belong to the same board
    let blockedBy: string[] | undefined;
    if (input.dependencies && input.dependencies.length > 0) {
      const uniqueBlockerIds = [...new Set(input.dependencies)];
      const blockers = await this.tasks
        .find({ taskId: { $in: uniqueBlockerIds }, boardId })
        .toArray();
      if (blockers.length !== uniqueBlockerIds.length) {
        const foundIds = new Set(blockers.map((t) => t.taskId));
        const missing = uniqueBlockerIds.filter((id) => !foundIds.has(id));
        throw new Error(`Blocker task(s) not found on board ${boardId}: ${missing.join(', ')}`);
      }
      blockedBy = uniqueBlockerIds;
    }

    // Get next position in column (FIFO — append to end)
    const lastTask = await this.tasks
      .find({ boardId, columnId })
      .sort({ position: -1 })
      .limit(1)
      .toArray();
    const position = lastTask.length > 0 ? lastTask[0].position + 1 : 0;

    const now = new Date().toISOString();

    // Derive initial taskStatus from context
    const initialStatus: TaskStatus = input.assignedAgentId ? 'assigned' : 'idle';

    const task: Task = {
      taskId: generateTaskId(),
      boardId,
      columnId,
      position,
      title: input.title,
      description: input.description,
      priority: input.priority ?? 'medium',
      taskStatus: initialStatus,
      tags: input.tags ?? [],
      assignedAgentId: input.assignedAgentId,
      running: false,
      parentTaskId: input.parentTaskId,
      dependencies: blockedBy ?? [],
      progressNotes: [],
      activity: [
        {
          eventType: 'created',
          actor: createdBy,
          timestamp: now,
        },
      ],
      createdBy,
      createdAt: now,
      updatedAt: now,
    };

    await this.tasks.insertOne(task);
    return task;
  }

  /**
   * Batch create tasks (atomic — all or nothing)
   */
  async batchCreateTasks(
    boardId: string,
    createdBy: string,
    inputs: CreateTaskInput[],
  ): Promise<Task[]> {
    if (inputs.length === 0) return [];
    if (inputs.length > 100) throw new Error('Batch create limited to 100 tasks');

    const board = await this.boards.findOne({ boardId });
    if (!board) throw new Error(`Board ${boardId} not found`);

    const now = new Date().toISOString();

    // Pre-compute positions per column
    const columnPositions = new Map<string, number>();

    // Get current max positions for all columns
    const existingTasks = await this.tasks
      .aggregate<{ _id: string; maxPos: number }>([
        { $match: { boardId } },
        { $group: { _id: '$columnId', maxPos: { $max: '$position' } } },
      ])
      .toArray();

    for (const t of existingTasks) {
      columnPositions.set(t._id, t.maxPos + 1);
    }

    // Pre-validate all dependencies IDs up front (single batch query for efficiency)
    const allBlockerIds = [
      ...new Set(inputs.flatMap((i) => i.dependencies ?? [])),
    ];
    let validBlockerIds: Set<string> = new Set();
    if (allBlockerIds.length > 0) {
      const foundBlockers = await this.tasks
        .find({ taskId: { $in: allBlockerIds }, boardId })
        .toArray();
      validBlockerIds = new Set(foundBlockers.map((t) => t.taskId));
      const missing = allBlockerIds.filter((id) => !validBlockerIds.has(id));
      if (missing.length > 0) {
        throw new Error(`Blocker task(s) not found on board ${boardId}: ${missing.join(', ')}`);
      }
    }

    const tasks: Task[] = [];

    for (const input of inputs) {
      // Validate title
      if (!input.title || input.title.trim().length === 0) {
        throw new Error('Every task must have a title');
      }

      // Determine column
      let columnId = input.columnId;
      if (!columnId) {
        columnId = board.columns[0]?.columnId;
        if (!columnId) throw new Error('Board has no columns');
      } else {
        const colExists = board.columns.some((c) => c.columnId === columnId);
        if (!colExists) throw new Error(`Column ${columnId} not found on board ${boardId}`);
      }

      // Get and increment position
      const position = columnPositions.get(columnId) ?? 0;
      columnPositions.set(columnId, position + 1);

      // Deduplicate dependencies for this task
      const blockedBy =
        input.dependencies && input.dependencies.length > 0
          ? [...new Set(input.dependencies)]
          : undefined;

      tasks.push({
        taskId: generateTaskId(),
        boardId,
        columnId,
        position,
        title: input.title.trim(),
        description: input.description,
        priority: input.priority ?? 'medium',
        taskStatus: input.assignedAgentId ? 'assigned' : 'idle',
        tags: input.tags ?? [],
        assignedAgentId: input.assignedAgentId,
        running: false,
        parentTaskId: input.parentTaskId,
        dependencies: blockedBy ?? [],
        progressNotes: [],
        activity: [
          {
            eventType: 'created',
            actor: createdBy,
            timestamp: now,
          },
        ],
        createdBy,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Atomic insert
    await this.tasks.insertMany(tasks);
    console.log(`[BoardService] Batch created ${tasks.length} tasks on board ${boardId}`);
    return tasks;
  }

  /**
   * Get a task by ID
   */
  async getTask(taskId: string): Promise<Task | null> {
    return this.tasks.findOne({ taskId });
  }

  /**
   * List tasks on a board with optional filters
   */
  async listTasks(boardId: string, filter?: ListTasksFilter): Promise<Task[]> {
    const query: Record<string, any> = { boardId };

    if (filter?.columnId) query.columnId = filter.columnId;
    if (filter?.assignedAgentId) query.assignedAgentId = filter.assignedAgentId;
    if (filter?.priority) query.priority = filter.priority;
    if (filter?.tags && filter.tags.length > 0) {
      query.tags = { $in: filter.tags };
    }

    return this.tasks
      .find(query)
      .sort({ columnId: 1, position: 1 })
      .toArray();
  }

  /**
   * Get all tasks assigned to a specific agent across all boards in a workspace
   */
  async getTasksByAgent(
    workspaceId: string,
    agentId: string,
  ): Promise<Array<Task & { projectName: string }>> {
    // Get all projects in workspace
    const projects = await this.projects
      .find({ workspaceId, status: 'active' })
      .toArray();

    if (projects.length === 0) return [];

    const boardIds = projects.map((p) => p.boardId);
    const projectByBoard = new Map(projects.map((p) => [p.boardId, p]));

    const tasks = await this.tasks
      .find({ boardId: { $in: boardIds }, assignedAgentId: agentId })
      .sort({ priority: 1, createdAt: -1 })
      .toArray();

    return tasks.map((task) => ({
      ...task,
      projectName: projectByBoard.get(task.boardId)?.name ?? 'Unknown',
    }));
  }

  /**
   * Update task properties (partial update)
   */
  async updateTask(
    taskId: string,
    actor: string,
    input: UpdateTaskInput,
  ): Promise<Task | null> {
    const task = await this.tasks.findOne({ taskId });
    if (!task) return null;

    const now = new Date().toISOString();
    const $set: Record<string, any> = { updatedAt: now };
    const activityEntries: TaskActivityEntry[] = [];

    if (input.title !== undefined) {
      $set.title = input.title;
      activityEntries.push({ eventType: 'updated', actor, timestamp: now, details: { field: 'title' } });
    }
    if (input.description !== undefined) {
      $set.description = input.description;
      activityEntries.push({ eventType: 'updated', actor, timestamp: now, details: { field: 'description' } });
    }
    if (input.priority !== undefined && input.priority !== task.priority) {
      $set.priority = input.priority;
      activityEntries.push({
        eventType: 'priority_changed',
        actor,
        timestamp: now,
        details: { oldPriority: task.priority, newPriority: input.priority },
      });
    }
    if (input.tags !== undefined) {
      $set.tags = input.tags;
      activityEntries.push({ eventType: 'updated', actor, timestamp: now, details: { field: 'tags' } });
    }
    if (input.assignedAgentId !== undefined) {
      if (input.assignedAgentId === null) {
        $set.assignedAgentId = undefined;
        activityEntries.push({
          eventType: 'unassigned',
          actor,
          timestamp: now,
          details: { agentId: task.assignedAgentId },
        });
      } else {
        $set.assignedAgentId = input.assignedAgentId;
        activityEntries.push({
          eventType: 'assigned',
          actor,
          timestamp: now,
          details: { agentId: input.assignedAgentId },
        });
      }
    }
    if (input.dependencies !== undefined) {
      if (input.dependencies.length === 0) {
        // Clearing all blockers
        $set.dependencies = undefined;
        activityEntries.push({ eventType: 'updated', actor, timestamp: now, details: { field: 'dependencies' } });
      } else {
        // Validate that all blocker IDs belong to the same board
        const uniqueBlockerIds = [...new Set(input.dependencies)];
        const blockers = await this.tasks
          .find({ taskId: { $in: uniqueBlockerIds }, boardId: task.boardId })
          .toArray();
        if (blockers.length !== uniqueBlockerIds.length) {
          const foundIds = new Set(blockers.map((t) => t.taskId));
          const missing = uniqueBlockerIds.filter((id) => !foundIds.has(id));
          throw new Error(`Blocker task(s) not found on board ${task.boardId}: ${missing.join(', ')}`);
        }
        $set.dependencies = uniqueBlockerIds;
        activityEntries.push({ eventType: 'updated', actor, timestamp: now, details: { field: 'dependencies' } });
      }
    }

    const updateOp: Record<string, any> = { $set };
    if (activityEntries.length > 0) {
      updateOp.$push = { activity: { $each: activityEntries } };
    }

    const result = await this.tasks.findOneAndUpdate(
      { taskId },
      updateOp,
      { returnDocument: 'after' },
    );
    return result ?? null;
  }

  /**
   * Move a task to a different column
   */
  async moveTask(
    taskId: string,
    actor: string,
    targetColumnId: string,
    position?: number,
  ): Promise<Task | null> {
    const task = await this.tasks.findOne({ taskId });
    if (!task) return null;

    // Validate column exists on board
    const board = await this.boards.findOne({ boardId: task.boardId });
    if (!board) return null;

    const targetColumn = board.columns.find((c) => c.columnId === targetColumnId);
    if (!targetColumn) throw new Error(`Column ${targetColumnId} not found`);

    const fromColumn = board.columns.find((c) => c.columnId === task.columnId);

    // Determine position (FIFO: append to end if not specified)
    let newPosition = position;
    if (newPosition === undefined) {
      const lastInColumn = await this.tasks
        .find({ boardId: task.boardId, columnId: targetColumnId })
        .sort({ position: -1 })
        .limit(1)
        .toArray();
      newPosition = lastInColumn.length > 0 ? lastInColumn[0].position + 1 : 0;
    }

    const sameColumn = task.columnId === targetColumnId;

    if (sameColumn && newPosition !== undefined) {
      // Reordering within the same column.
      // Frontend sends the visual drop index (with the dragged task still in the list).
      // Convert to final position: if dropping below original, subtract 1 since
      // removing the task shifts everything above the drop point up.
      const oldPos = task.position;
      let finalPos = newPosition > oldPos ? newPosition - 1 : newPosition;

      if (finalPos === oldPos) {
        // No change needed
        return task;
      }

      if (finalPos < oldPos) {
        // Moving up: shift tasks in [finalPos, oldPos) down by 1
        await this.tasks.updateMany(
          { boardId: task.boardId, columnId: targetColumnId, taskId: { $ne: taskId }, position: { $gte: finalPos, $lt: oldPos } },
          { $inc: { position: 1 } },
        );
      } else {
        // Moving down: shift tasks in (oldPos, finalPos] up by 1
        await this.tasks.updateMany(
          { boardId: task.boardId, columnId: targetColumnId, taskId: { $ne: taskId }, position: { $gt: oldPos, $lte: finalPos } },
          { $inc: { position: -1 } },
        );
      }
      newPosition = finalPos;
    } else if (!sameColumn) {
      // Moving to a different column: close gap in source, make room in target
      await this.tasks.updateMany(
        { boardId: task.boardId, columnId: task.columnId, position: { $gt: task.position } },
        { $inc: { position: -1 } },
      );
      await this.tasks.updateMany(
        { boardId: task.boardId, columnId: targetColumnId, position: { $gte: newPosition } },
        { $inc: { position: 1 } },
      );
    }

    const now = new Date().toISOString();
    const activityEntry: TaskActivityEntry = {
      eventType: 'moved',
      actor,
      timestamp: now,
      details: {
        fromColumn: fromColumn?.name ?? task.columnId,
        toColumn: targetColumn.name,
      },
    };

    const result = await this.tasks.findOneAndUpdate(
      { taskId },
      {
        $set: {
          columnId: targetColumnId,
          position: newPosition,
          updatedAt: now,
        },
        $push: { activity: activityEntry },
      },
      { returnDocument: 'after' },
    );
    return result ?? null;
  }

  /**
   * Assign or unassign an agent to a task
   */
  async assignTask(
    taskId: string,
    actor: string,
    agentId?: string | null,
  ): Promise<Task | null> {
    const task = await this.tasks.findOne({ taskId });
    if (!task) return null;

    const now = new Date().toISOString();
    let activityEntry: TaskActivityEntry;

    if (!agentId) {
      activityEntry = {
        eventType: 'unassigned',
        actor,
        timestamp: now,
        details: { agentId: task.assignedAgentId },
      };
    } else {
      activityEntry = {
        eventType: 'assigned',
        actor,
        timestamp: now,
        details: { agentId },
      };
    }

    // Derive taskStatus: if assigning → 'assigned', if unassigning → 'idle'
    // Only change if task isn't already in a more advanced state (working/review/done)
    const statusUpdate: Partial<Task> = {};
    if (agentId && (task.taskStatus === 'idle' || !task.taskStatus)) {
      statusUpdate.taskStatus = 'assigned';
    } else if (!agentId && (task.taskStatus === 'assigned' || task.taskStatus === 'idle')) {
      statusUpdate.taskStatus = 'idle';
    }

    const result = await this.tasks.findOneAndUpdate(
      { taskId },
      {
        $set: {
          assignedAgentId: agentId ?? undefined,
          updatedAt: now,
          ...statusUpdate,
        },
        $push: { activity: activityEntry },
      },
      { returnDocument: 'after' },
    );
    return result ?? null;
  }

  /**
   * Start a task: move to in_progress, return info for conversation creation
   *
   * The actual conversation creation is handled by the caller (websocket handler)
   * since it requires ChannelManager which is outside BoardService's scope.
   *
   * Returns the updated task and the in_progress column ID.
   */
  async startTask(
    taskId: string,
    actor: string,
    agentIdOverride?: string,
  ): Promise<{ task: Task; inProgressColumnId: string }> {
    const task = await this.tasks.findOne({ taskId });
    if (!task) throw new Error(`Task ${taskId} not found`);

    // Determine agent
    const agentId = agentIdOverride ?? task.assignedAgentId;
    if (!agentId) {
      throw new Error('Cannot start task: no agent assigned and no agentId provided');
    }

    // Find in_progress column
    const board = await this.boards.findOne({ boardId: task.boardId });
    if (!board) throw new Error(`Board ${task.boardId} not found`);

    const inProgressCol = board.columns.find((c) => c.slug === 'in_progress');
    if (!inProgressCol) throw new Error('Board has no "in_progress" column');

    const now = new Date().toISOString();
    const activityEntries: TaskActivityEntry[] = [];

    // If agent override, update assignment
    if (agentIdOverride && agentIdOverride !== task.assignedAgentId) {
      activityEntries.push({
        eventType: 'assigned',
        actor,
        timestamp: now,
        details: { agentId: agentIdOverride },
      });
    }

    // Move to in_progress
    const lastInColumn = await this.tasks
      .find({ boardId: task.boardId, columnId: inProgressCol.columnId })
      .sort({ position: -1 })
      .limit(1)
      .toArray();
    const position = lastInColumn.length > 0 ? lastInColumn[0].position + 1 : 0;

    activityEntries.push({
      eventType: 'started',
      actor,
      timestamp: now,
      details: {
        fromColumn: board.columns.find((c) => c.columnId === task.columnId)?.name ?? task.columnId,
        toColumn: inProgressCol.name,
        agentId,
      },
    });

    const result = await this.tasks.findOneAndUpdate(
      { taskId },
      {
        $set: {
          assignedAgentId: agentId,
          columnId: inProgressCol.columnId,
          position,
          taskStatus: 'working' as const,
          updatedAt: now,
        },
        $push: { activity: { $each: activityEntries } },
      },
      { returnDocument: 'after' },
    );

    if (!result) throw new Error(`Failed to update task ${taskId}`);

    return { task: result, inProgressColumnId: inProgressCol.columnId };
  }

  /**
   * Link a conversation to a task
   */
  async linkConversation(
    taskId: string,
    actor: string,
    channelId: string,
  ): Promise<Task | null> {
    const now = new Date().toISOString();

    const result = await this.tasks.findOneAndUpdate(
      { taskId },
      {
        $set: { channelId, updatedAt: now },
        $push: {
          activity: {
            eventType: 'linked' as TaskActivityEventType,
            actor,
            timestamp: now,
            details: { channelId },
          },
        },
      },
      { returnDocument: 'after' },
    );
    return result ?? null;
  }

  /**
   * Update task semantic status.
   *
   * Auto-moves to matching column when appropriate:
   * - 'review' → moves to review column
   * - 'done' → moves to done column
   *
   * Returns the updated task and the previous status (for event emission).
   */
  async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    actor: string,
  ): Promise<{ task: Task; previousStatus: TaskStatus } | null> {
    const task = await this.tasks.findOne({ taskId });
    if (!task) return null;

    const previousStatus = task.taskStatus ?? 'idle';
    if (previousStatus === status) {
      return { task, previousStatus };
    }

    const now = new Date().toISOString();
    const $set: Record<string, unknown> = {
      taskStatus: status,
      updatedAt: now,
    };

    // Auto-move to matching column
    const board = await this.boards.findOne({ boardId: task.boardId });
    if (board) {
      const targetSlug =
        status === 'review'
          ? 'review'
          : status === 'done'
            ? 'done'
            : null;

      if (targetSlug) {
        const targetCol = board.columns.find((c) => c.slug === targetSlug);
        if (targetCol && task.columnId !== targetCol.columnId) {
          // Get next position in target column
          const lastInCol = await this.tasks
            .find({ boardId: task.boardId, columnId: targetCol.columnId })
            .sort({ position: -1 })
            .limit(1)
            .toArray();
          $set.columnId = targetCol.columnId;
          $set.position = lastInCol.length > 0 ? lastInCol[0].position + 1 : 0;
        }
      }
    }

    const activityEntry: TaskActivityEntry = {
      eventType: 'status_changed',
      actor,
      timestamp: now,
      details: { fromStatus: previousStatus, toStatus: status },
    };

    const result = await this.tasks.findOneAndUpdate(
      { taskId },
      { $set, $push: { activity: activityEntry } },
      { returnDocument: 'after' },
    );

    if (!result) return null;
    return { task: result, previousStatus };
  }

  /**
   * Add a progress note to a task.
   *
   * Progress notes are lightweight updates from agents about what they're doing.
   * They're separate from the activity log (which tracks structural changes).
   */
  async addProgressNote(
    taskId: string,
    text: string,
    actor: string,
  ): Promise<Task | null> {
    const now = new Date().toISOString();

    const note: ProgressNote = { text, actor, timestamp: now };

    const activityEntry: TaskActivityEntry = {
      eventType: 'progress_note',
      actor,
      timestamp: now,
      details: { note: text },
    };

    const result = await this.tasks.findOneAndUpdate(
      { taskId },
      {
        $set: { updatedAt: now },
        $push: {
          progressNotes: note,
          activity: activityEntry,
        },
      },
      { returnDocument: 'after' },
    );
    return result ?? null;
  }

  /**
   * Set the origin channel ID on a task (the channel that triggered start_task).
   * Used for event notifications back to the super-agent.
   */
  async setOriginChannel(taskId: string, originChannelId: string): Promise<void> {
    await this.tasks.updateOne(
      { taskId },
      { $set: { originChannelId } },
    );
  }

  /**
   * Set the running flag on a task (system-controlled).
   *
   * Returns the updated task if the flag actually changed, or null if:
   * - Task not found
   * - Flag was already at the desired value (no-op)
   */
  async setRunning(taskId: string, running: boolean): Promise<Task | null> {
    const task = await this.tasks.findOne({ taskId });
    if (!task) return null;

    // No-op if already in the desired state
    if (task.running === running) return null;

    const now = new Date().toISOString();

    const result = await this.tasks.findOneAndUpdate(
      { taskId },
      {
        $set: { running, updatedAt: now },
        $push: {
          activity: {
            eventType: 'running_changed' as const,
            actor: 'system',
            timestamp: now,
            details: { running },
          },
        },
      },
      { returnDocument: 'after' },
    );

    return result ?? null;
  }

  /**
   * Delete a task. Sub-tasks become top-level.
   */
  async deleteTask(taskId: string): Promise<boolean> {
    const task = await this.tasks.findOne({ taskId });
    if (!task) return false;

    // Promote sub-tasks to top-level
    await this.tasks.updateMany(
      { parentTaskId: taskId },
      { $unset: { parentTaskId: '' }, $set: { updatedAt: new Date().toISOString() } },
    );

    await this.tasks.deleteOne({ taskId });
    console.log(`[BoardService] Deleted task ${taskId}`);
    return true;
  }

  /**
   * Get task by linked channelId (for reverse navigation)
   */
  async getTaskByChannel(channelId: string): Promise<Task | null> {
    return this.tasks.findOne({ channelId });
  }

  /**
   * Clear channelId from a task when a conversation is deleted
   */
  async unlinkConversation(channelId: string): Promise<void> {
    await this.tasks.updateOne(
      { channelId },
      { $unset: { channelId: '' }, $set: { updatedAt: new Date().toISOString() } },
    );
  }

  /**
   * Unassign an agent from all tasks in a workspace
   * (used when agent is removed from workspace)
   */
  async unassignAgentFromWorkspace(workspaceId: string, agentId: string): Promise<void> {
    const projects = await this.projects.find({ workspaceId }).toArray();
    const boardIds = projects.map((p) => p.boardId);

    if (boardIds.length > 0) {
      await this.tasks.updateMany(
        { boardId: { $in: boardIds }, assignedAgentId: agentId },
        { $unset: { assignedAgentId: '' }, $set: { updatedAt: new Date().toISOString() } },
      );
    }
  }

  /**
   * Resolve agent info (name, avatar) for a set of agent IDs.
   * Returns a map of agentId → { name, fullName, avatarUrl }.
   */
  async resolveAgents(
    agentIds: string[],
  ): Promise<Record<string, { name: string; fullName: string; avatarUrl?: string }>> {
    if (agentIds.length === 0) return {};

    const agents = await this.db
      .collection('agents')
      .find(
        { agentId: { $in: agentIds } },
        { projection: { agentId: 1, name: 1, fullName: 1, avatarUrl: 1 } },
      )
      .toArray();

    const map: Record<string, { name: string; fullName: string; avatarUrl?: string }> = {};
    for (const a of agents) {
      map[a.agentId] = {
        name: a.name || a.agentId,
        fullName: a.fullName || a.name || a.agentId,
        avatarUrl: a.avatarUrl,
      };
    }
    return map;
  }

  /**
   * Collect unique agent IDs from a list of tasks.
   */
  collectAgentIds(tasks: Task[]): string[] {
    const ids = new Set<string>();
    for (const t of tasks) {
      if (t.assignedAgentId) ids.add(t.assignedAgentId);
      if (t.createdBy && !t.createdBy.startsWith('user_')) ids.add(t.createdBy);
      for (const note of t.progressNotes || []) {
        if (note.actor && !note.actor.startsWith('user_')) ids.add(note.actor);
      }
    }
    return Array.from(ids);
  }

  // ==========================================================================
  // DEPENDENCIES
  // ==========================================================================

  /**
   * Detect a cycle in the dependency graph using iterative DFS.
   *
   * Checks whether adding the edge  fromTaskId → toTaskId  would create a cycle.
   * A cycle exists if toTaskId is already reachable from fromTaskId following
   * existing dependency edges (i.e. toTaskId can reach fromTaskId).
   *
   * We load the full set of tasks for the board once and traverse in-memory,
   * which is efficient enough for boards (typically < 500 tasks).
   *
   * @returns An array of taskIds forming the cycle path, or [] if no cycle.
   */
  async detectCycle(
    boardId: string,
    fromTaskId: string,
    toTaskId: string,
  ): Promise<string[]> {
    // Load all tasks for the board into a map for O(1) lookup
    const allTasks = await this.tasks.find({ boardId }).toArray();
    const taskMap = new Map<string, Task>(allTasks.map((t) => [t.taskId, t]));

    // Build adjacency list: taskId → [blockedByTaskId, ...]
    const adj = new Map<string, string[]>();
    for (const t of allTasks) {
      adj.set(t.taskId, t.dependencies ?? []);
    }

    // Temporarily add the proposed new edge fromTaskId → toTaskId
    const existing = adj.get(fromTaskId) ?? [];
    adj.set(fromTaskId, [...existing, toTaskId]);

    // Iterative DFS from toTaskId to check if we can reach fromTaskId
    // (which would confirm a cycle: fromTaskId → ... → fromTaskId)
    const visited = new Set<string>();
    const stack: Array<{ node: string; path: string[] }> = [
      { node: toTaskId, path: [toTaskId] },
    ];

    while (stack.length > 0) {
      const { node, path } = stack.pop()!;

      if (node === fromTaskId) {
        // Cycle detected — return the full cycle path
        return [...path, fromTaskId];
      }

      if (visited.has(node)) continue;
      visited.add(node);

      const neighbors = adj.get(node) ?? [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          stack.push({ node: neighbor, path: [...path, neighbor] });
        }
      }
    }

    return []; // No cycle
  }

  /**
   * Add a dependency: taskId depends on dependsOnTaskId.
   *
   * Both tasks must exist on the same board.
   * Performs DFS cycle detection before persisting.
   * If a cycle is detected, marks all involved tasks with status
   * `circular_dependency` and throws a descriptive error.
   */
  async addDependency(
    taskId: string,
    dependsOnTaskId: string,
    actor: string,
  ): Promise<Task> {
    if (taskId === dependsOnTaskId) {
      throw new Error(`CIRCULAR_DEPENDENCY: A task cannot depend on itself (${taskId})`);
    }

    const task = await this.tasks.findOne({ taskId });
    if (!task) throw new Error(`Task ${taskId} not found`);

    const depTask = await this.tasks.findOne({ taskId: dependsOnTaskId });
    if (!depTask) throw new Error(`Dependency task ${dependsOnTaskId} not found`);

    if (task.boardId !== depTask.boardId) {
      throw new Error('Cross-board dependencies are not supported');
    }

    // Idempotency: already has this dependency
    if ((task.dependencies ?? []).includes(dependsOnTaskId)) {
      return task;
    }

    // DFS cycle check
    const cyclePath = await this.detectCycle(task.boardId, taskId, dependsOnTaskId);

    if (cyclePath.length > 0) {
      const cycleDescription = cyclePath.join(' → ');
      const now = new Date().toISOString();

      // Mark all tasks in the cycle as circular_dependency
      const cycleTaskIds = [...new Set(cyclePath)];
      await this.tasks.updateMany(
        { taskId: { $in: cycleTaskIds } },
        {
          $set: { taskStatus: 'circular_dependency' as const, updatedAt: now },
          $push: {
            activity: {
              eventType: 'circular_dependency_detected' as const,
              actor,
              timestamp: now,
              details: { note: `Circular dependency detected: ${cycleDescription}` },
            },
          },
        },
      );

      console.warn(
        `[BoardService] Circular dependency detected on board ${task.boardId}: ${cycleDescription}`,
      );

      throw new Error(
        `CIRCULAR_DEPENDENCY: Adding dependency ${taskId} → ${dependsOnTaskId} would create a cycle: ${cycleDescription}`,
      );
    }

    // Safe to add — persist
    const now = new Date().toISOString();
    const result = await this.tasks.findOneAndUpdate(
      { taskId },
      {
        $addToSet: { dependencies: dependsOnTaskId },
        $set: { updatedAt: now },
        $push: {
          activity: {
            eventType: 'dependency_added' as const,
            actor,
            timestamp: now,
            details: { note: `Added dependency on ${dependsOnTaskId}` },
          },
        },
      },
      { returnDocument: 'after' },
    );

    if (!result) throw new Error(`Failed to update task ${taskId}`);
    return result;
  }

  /**
   * Remove a dependency: taskId no longer depends on dependsOnTaskId.
   *
   * If either task had status `circular_dependency` due to this edge,
   * the status is NOT automatically cleared — that requires a separate
   * review since other cycles may still exist.
   */
  async removeDependency(
    taskId: string,
    dependsOnTaskId: string,
    actor: string,
  ): Promise<Task> {
    const task = await this.tasks.findOne({ taskId });
    if (!task) throw new Error(`Task ${taskId} not found`);

    // Idempotency: dependency doesn't exist
    if (!(task.dependencies ?? []).includes(dependsOnTaskId)) {
      return task;
    }

    const now = new Date().toISOString();
    const result = await this.tasks.findOneAndUpdate(
      { taskId },
      {
        $pull: { dependencies: dependsOnTaskId },
        $set: { updatedAt: now },
        $push: {
          activity: {
            eventType: 'dependency_removed' as const,
            actor,
            timestamp: now,
            details: { note: `Removed dependency on ${dependsOnTaskId}` },
          },
        },
      },
      { returnDocument: 'after' },
    );

    if (!result) throw new Error(`Failed to update task ${taskId}`);
    return result;
  }

  /**
   * Get board summary (task counts per column)
   */
  async getBoardSummary(boardId: string): Promise<{
    board: Board;
    columnSummaries: Array<{ columnId: string; name: string; count: number }>;
    totalTasks: number;
  } | null> {
    const board = await this.boards.findOne({ boardId });
    if (!board) return null;

    const counts = await this.tasks
      .aggregate<{ _id: string; count: number }>([
        { $match: { boardId } },
        { $group: { _id: '$columnId', count: { $sum: 1 } } },
      ])
      .toArray();

    const countMap = new Map(counts.map((c) => [c._id, c.count]));

    const columnSummaries = board.columns.map((col) => ({
      columnId: col.columnId,
      name: col.name,
      count: countMap.get(col.columnId) ?? 0,
    }));

    const totalTasks = counts.reduce((sum, c) => sum + c.count, 0);

    return { board, columnSummaries, totalTasks };
  }
}

/**
 * Build the initial message sent to an agent when a task is started.
 */
export function buildTaskInitialMessage(task: {
  taskId: string;
  title: string;
  description?: string;
  priority?: string;
  tags?: string[];
}, customPrompt?: string, boardRunnerAppName: string = 'boards'): string {
  if (customPrompt) return customPrompt;

  const taskDescription = task.description || 'No description provided.';
  return [
    `You have been assigned a task. Execute it autonomously.`,
    ``,
    `## Task: ${task.title}`,
    `**Priority:** ${task.priority || 'medium'}`,
    `**Tags:** ${task.tags?.length ? task.tags.join(', ') : 'none'}`,
    ``,
    `## Description`,
    taskDescription,
    ``,
    `## Instructions`,
    `- Work autonomously. If tools require user approval, the user will be notified.`,
    `- Use the \`${boardRunnerAppName}_add-progress-note\` tool (taskId: \`${task.taskId}\`) to report progress and any issues.`,
    `- When you finish, use \`${boardRunnerAppName}_update-my-task-status\` (taskId: \`${task.taskId}\`, status: \`done\`) to mark the task as complete.`,
    `- If you cannot complete the task, set status to \`blocked\` and add a progress note explaining why.`,
  ].join('\n');
}
