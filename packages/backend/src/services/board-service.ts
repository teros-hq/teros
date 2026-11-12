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
  RandomIdGenerator,
  type IdGenerator,
} from '@teros/core';
import { COLLECTIONS, ensureCollectionIndexes } from '../db';
import type { Collection, Db, Document } from 'mongodb';
import { normalizeTags } from '@teros/shared';
import { buildAvatarUrl } from '../lib/avatar-url';
import { mapActivityTypeToEventCategory, type BoardEventService } from './board-event-service';
import type {
  Board,
  BoardColumn,
  BoardEventCategory,
  BoardEventDetails,
  ProgressNote,
  Project,
  Task,
  TaskActivityEntry,
  TaskActivityEventType,
  TaskPriority, TaskArtifact } from '../types/database';
import { DeletionService } from './deletion-service';
import { cappedPush, TASK_ACTIVITY_CAP, TASK_PROGRESS_NOTES_CAP } from '../lib/task-arrays';

// ============================================================================
// DEFAULT COLUMNS
// ============================================================================

const DEFAULT_COLUMNS: Array<{ name: string; slug: string }> = [
  { name: 'Backlog', slug: 'backlog' },
  { name: 'To Do', slug: 'todo' },
  { name: 'In Progress', slug: 'in_progress' },
  { name: 'Blocked', slug: 'blocked' },
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


/**
 * Normaliza `tags` a `string[]`.
 *
 * Defensa en profundidad: algunos LLMs pasan el array como string JSON
 * ('["a","b"]') y el string llegaba intacto a MongoDB, rompiendo
 * `task.tags.join()` en el frontend (bug "task.tags.join is not a function",
 * que bloqueaba la ventana de conversación entera). El MCA board-manager ya
 * normaliza en su capa; esto protege el resto de callers del backend.
 */
function normalizeTagsInput(tags: unknown): string[] | undefined {
  if (tags === undefined || tags === null) return undefined;
  if (Array.isArray(tags)) {
    return tags.map((t) => String(t).trim()).filter(Boolean);
  }
  if (typeof tags === 'string') {
    const trimmed = tags.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.map((t) => String(t).trim()).filter(Boolean);
        }
      } catch {
        // fallback CSV abajo
      }
    }
    return trimmed
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((t) => t.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
  }
  return undefined;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  /** Detailed task instructions in markdown — required so assigned agents have context for autonomous execution. */
  instructions: string;
  priority?: TaskPriority;
  tags?: string[];
  assignedAgentId?: string;
  columnId?: string;
  parentTaskId?: string;
  /** IDs of tasks that block this task. Must belong to the same board. */
  dependencies?: string[];

  // --- Workflow extensions (§WF2) ---
  // Set by the workflow engine when creating a task for a workflow node.
  // All optional — absent for manually created tasks.

  /** Input gate from the workflow node (routing metadata) */
  workflowInputGate?: Record<string, unknown>;
  /** Output gate from the workflow node (routing metadata) */
  workflowOutputGate?: Record<string, unknown>;
  /** Reference to the workflow execution that created this task */
  workflowExecutionId?: string;
  /** Reference to the workflow node that created this task */
  workflowNodeId?: string;

  // --- Artifacts (docs/specs/tasks/artifacts.md) ---
  /** What the task receives (event payload, upstream gate data, …). */
  input?: TaskArtifact;
  /** What the task is expected to deliver (type + schema; data filled on completion). */
  output?: TaskArtifact;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  instructions?: string;
  priority?: TaskPriority;
  tags?: string[];
  assignedAgentId?: string | null;
  /** IDs of tasks that block this task. Must belong to the same board. */
  dependencies?: string[];

  /** Deliverable value → `output.data` (humans via the window, agents via complete-my-task, flows on validation). */
  outputData?: unknown;
}

export interface ListTasksFilter {
  columnId?: string;
  assignedAgentId?: string;
  priority?: TaskPriority;
  tags?: string[];
  archived?: boolean;
  /**
   * Mongo projection applied to the returned task documents.
   *
   * Large boards return hundreds of tasks in a single response (board.get /
   * board.list-tasks). Full documents carry heavy per-task fields that only the
   * task detail needs: `activity` (~46% of the payload, and its progress_note
   * entries duplicate `progressNotes`), `progressNotes` (~37%), `instructions`
   * (~12%), plus `input` / `output` / workflow data. Callers that render lists
   * pass a projection here; callers that need full docs (MCA board-manager,
   * get-task sub-task resolution) omit it and get complete documents.
   *
   * Array fields accept `{ $slice: n }` to keep only the last |n| elements
   * (e.g. `progressNotes: { $slice: -1 }` for "last note only").
   */
  projection?: Record<string, 0 | 1 | { $slice: number }>;
}

/**
 * Projection for board list responses (board.get / board.list-tasks).
 *
 * Strips the heavy per-task fields that only the task detail consumes:
 *  - `activity` and `progressNotes` — the detail panel fetches them via
 *    board.get-task; the MissionControl feed reads board_events, not these.
 *  - `instructions`, `input`, `output`, `workflowInputData`, `workflowOutputData`
 *    — detail-panel-only content.
 * `_id` is excluded because it is a Mongo internal.
 */
export const TASK_LIST_PROJECTION: Record<string, 0 | 1 | { $slice: number }> = {
  _id: 0,
  activity: 0,
  progressNotes: 0,
  instructions: 0,
  input: 0,
  output: 0,
  workflowInputData: 0,
  workflowOutputData: 0,
};

// ============================================================================
// BOARD SERVICE
// ============================================================================

export class BoardService {
  private projects: Collection<Project>;
  private boards: Collection<Board>;
  private tasks: Collection<Task>;
  /** Channels — used to sync linked conversation titles on task rename. */
  private channels: Collection<Document>;
  /** taskId sembrable: en modo determinista (TEROS_DETERMINISTIC) el board runner inyecta el
   * taskId en el prompt del agente (getBoardTaskPrompt), así que un id aleatorio rompía el hash
   * del replay LLM. Con SeededIdGenerator es estable; en prod es RandomIdGenerator. TER-563. */
  private readonly taskIds: IdGenerator;
  /** BoardEventService for persisting events to board_events collection. Optional for backward compat. */
  private readonly boardEventService: BoardEventService | null;

  constructor(
    private db: Db,
    idGenerator?: IdGenerator,
    boardEventService?: BoardEventService,
  ) {
    this.projects = db.collection<Project>('projects');
    this.boards = db.collection<Board>('boards');
    this.tasks = db.collection<Task>('tasks');
    // Channels collection — used only to sync the linked conversation's title
    // when a task title changes (task.channelId ↔ channel title invariant).
    this.channels = db.collection('channels');
    this.taskIds = (idGenerator ?? new RandomIdGenerator()).fork('task');
    this.boardEventService = boardEventService ?? null;
  }

  // ==========================================================================
  // EVENT RECORDING HELPER
  // ==========================================================================

  /**
   * Record a board event to the board_events collection.
   * Awaited so events land in order and before the caller returns (MOD-4:
   * fire-and-forget lost them silently and could reorder a batch); a failure
   * is logged and doesn't fail the task write, which already happened.
   * Maps legacy TaskActivityEventType to BoardEventCategory.
   */
  private async _recordEvent(
    boardId: string,
    projectId: string,
    workspaceId: string,
    task: { taskId: string; title: string } | null,
    eventType: TaskActivityEventType | BoardEventCategory,
    actor: string,
    details?: BoardEventDetails,
  ): Promise<void> {
    if (!this.boardEventService) return;
    const category = eventType.includes('.')
      ? (eventType as BoardEventCategory)
      : mapActivityTypeToEventCategory(eventType);
    await this.boardEventService
      .recordEvent({
        boardId,
        projectId,
        workspaceId,
        taskId: task?.taskId ?? null,
        taskTitle: task?.title ?? null,
        eventType: category,
        actor,
        details,
      })
      .catch((err) => {
        console.error('[BoardService] Error recording board event:', err);
      });
  }

  // ==========================================================================
  // INDEXES
  // ==========================================================================

  async ensureIndexes(): Promise<void> {
    // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry with
    // ensureAllIndexes after migrations. Kept for tests and scripts.
    await ensureCollectionIndexes(this.projects, COLLECTIONS.projects);
    await ensureCollectionIndexes(this.boards, COLLECTIONS.boards);
    await ensureCollectionIndexes(this.tasks, COLLECTIONS.tasks);
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
      workspaceId,
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
   * List projects in a workspace.
   * By default only active projects are returned.
   * Pass includeArchived=true to also include archived projects.
   */
  async listProjects(workspaceId: string, includeArchived?: boolean): Promise<Project[]> {
    const query: Record<string, unknown> = { workspaceId };
    if (!includeArchived) {
      query.status = 'active';
    }
    return this.projects
      .find(query)
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
    // Strip undefined values — MongoDB $set treats undefined as field deletion (TER-313)
    const filtered = Object.fromEntries(
      Object.entries(update).filter(([, v]) => v !== undefined),
    );
    const result = await this.projects.findOneAndUpdate(
      { projectId },
      { $set: { ...filtered, updatedAt: new Date().toISOString() } },
      { returnDocument: 'after' },
    );
    return result ?? null;
  }

  /**
   * Archive a project (soft-delete) and all its non-archived tasks.
   * Idempotent — if already archived, just returns the project.
   */
  async archiveProject(
    projectId: string,
    actor: string,
    archiveNote?: string,
  ): Promise<Project | null> {
    const project = await this.projects.findOne({ projectId });
    if (!project) return null;

    // Idempotent: if already archived, return as-is
    if (project.status === 'archived') {
      return project;
    }

    const now = new Date().toISOString();
    const $set: Record<string, unknown> = {
      status: 'archived',
      updatedAt: now,
    };
    if (archiveNote) {
      $set.archiveNote = archiveNote;
    }

    // Archive all non-archived tasks belonging to the project's board
    await this.tasks.updateMany(
      { boardId: project.boardId, archived: { $ne: true } },
      {
        $set: { archived: true, updatedAt: now },
        $push: {
          activity: cappedPush({
            eventType: 'status_changed',
            actor,
            timestamp: now,
            details: { fromStatus: 'active', toStatus: 'archived' },
          }, TASK_ACTIVITY_CAP),
        },
      },
    );

    const result = await this.projects.findOneAndUpdate(
      { projectId },
      { $set },
      { returnDocument: 'after' },
    );

    console.log(`[BoardService] Archived project ${projectId} and all associated tasks`);
    return result ?? null;
  }

  /**
   * Delete a project, its board, and all tasks
   * Linked conversations are NOT deleted.
   */
  /**
   * Delete a project and everything on its board — same cascade as
   * ProjectService.delete (INF-3: the two paths used to leave different
   * orphans; this one skipped events, stats, subscriptions, relationships).
   */
  async deleteProject(projectId: string, actor = 'system'): Promise<boolean> {
    const project = await this.projects.findOne({ projectId });
    if (!project) return false;

    await new DeletionService(this.db).deleteProject(projectId, actor);

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

    const task: Task = {
      taskId: `task_${this.taskIds.hex16()}`,
      boardId,
      columnId,
      position,
      title: input.title,
      description: input.description,
      instructions: input.instructions,
      priority: input.priority ?? 'medium',
      archived: false,
      tags: normalizeTagsInput(input.tags) ?? [],
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
      // Workflow linkage — only present when created by the workflow engine
      workflowInputGate: input.workflowInputGate,
      workflowOutputGate: input.workflowOutputGate,
      workflowExecutionId: input.workflowExecutionId,
      workflowNodeId: input.workflowNodeId,
      // Artifacts — any creator may set them
      ...(input.input ? { input: input.input } : {}),
      ...(input.output ? { output: input.output } : {}),
    };

    await this.tasks.insertOne(task);

    // Record event to board_events collection
    const project = await this.projects.findOne({ boardId });
    if (project) {
      await this._recordEvent(boardId, project.projectId, project.workspaceId, task, 'created', createdBy);
    }

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
        taskId: `task_${this.taskIds.hex16()}`,
        boardId,
        columnId,
        position,
        title: input.title.trim(),
        description: input.description,
        instructions: input.instructions,
        priority: input.priority ?? 'medium',
        archived: false,
        tags: normalizeTagsInput(input.tags) ?? [],
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
        // Workflow linkage — only present when created by the workflow engine
        workflowInputGate: input.workflowInputGate,
        workflowOutputGate: input.workflowOutputGate,
        workflowExecutionId: input.workflowExecutionId,
        workflowNodeId: input.workflowNodeId,
        ...(input.input ? { input: input.input } : {}),
        ...(input.output ? { output: input.output } : {}),
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
    if (filter?.archived !== undefined) {
      query.archived = filter.archived;
    } else {
      // Default: exclude archived tasks from board views
      query.archived = false;
    }

    const cursor = this.tasks.find(query, {
      ...(filter?.projection ? { projection: filter.projection } : {}),
    });

    return cursor.sort({ columnId: 1, position: 1 }).toArray();
  }

  /**
   * Get all tasks assigned to a specific agent across all boards in a workspace
   */
  async getTasksByAgent(
    workspaceId: string,
    agentId: string,
    tags?: string[],
  ): Promise<Array<Task & { projectName: string }>> {
    // Get all projects in workspace
    const projects = await this.projects
      .find({ workspaceId, status: 'active' })
      .toArray();

    if (projects.length === 0) return [];

    const boardIds = projects.map((p) => p.boardId);
    const projectByBoard = new Map(projects.map((p) => [p.boardId, p]));

    const query: Record<string, any> = { boardId: { $in: boardIds }, assignedAgentId: agentId };
    if (tags && tags.length > 0) {
      query.tags = { $all: tags };
    }

    const tasks = await this.tasks
      .find(query)
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
    if (input.instructions !== undefined) {
      $set.instructions = input.instructions;
      activityEntries.push({ eventType: 'updated', actor, timestamp: now, details: { field: 'instructions' } });
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
      $set.tags = normalizeTagsInput(input.tags) ?? [];
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
    if (input.outputData !== undefined) {
      // Only the value changes; the type (schemaId / schema) set at creation stays.
      $set['output.data'] = input.outputData;
      if (!task.output || task.output.schemaId === undefined) $set['output.schemaId'] = task.output?.schemaId ?? null;
      activityEntries.push({ eventType: 'updated', actor, timestamp: now, details: { field: 'output' } });
    }

    const updateOp: Record<string, any> = { $set };
    if (activityEntries.length > 0) {
      updateOp.$push = { activity: cappedPush(activityEntries, TASK_ACTIVITY_CAP) };
    }

    const result = await this.tasks.findOneAndUpdate(
      { taskId },
      updateOp,
      { returnDocument: 'after' },
    );

    // Sync the linked conversation's title when the task title changed —
    // the "task title = linked conversation title" invariant. The channel
    // rename goes straight to the channels collection (not through
    // ChannelManager.renameChannel, which intentionally blocks task-linked
    // channels to prevent drift from the other direction).
    if (result?.channelId && input.title !== undefined && input.title !== task.title) {
      try {
        await this.channels.updateOne(
          { channelId: result.channelId },
          { $set: { 'metadata.name': result.title, updatedAt: now } },
        );
      } catch (err) {
        // Non-fatal: the task update already succeeded; a stale channel
        // title is recoverable by renaming the task again.
        console.warn(
          `[BoardService.updateTask] Failed to sync linked channel title for task ${taskId}:`,
          err,
        );
      }
    }

    // Record events to board_events collection
    if (result) {
      const board = await this.boards.findOne({ boardId: result.boardId });
      const project = board ? await this.projects.findOne({ projectId: board.projectId }) : null;
      if (board && project) {
        for (const entry of activityEntries) {
          await this._recordEvent(result.boardId, board.projectId, project.workspaceId, result, entry.eventType, actor, entry.details as BoardEventDetails);
        }
      }
    }

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
    const isRealMove = !sameColumn;

    const updateSet: Record<string, unknown> = {
      columnId: targetColumnId,
      position: newPosition,
      updatedAt: now,
    };
    const updateDoc: Record<string, unknown> = { $set: updateSet };

    // Only record an activity entry and reset autoWakeCount for real
    // column moves — not for reordering within the same column.
    if (isRealMove) {
      const activityEntry: TaskActivityEntry = {
        eventType: 'moved',
        actor,
        timestamp: now,
        details: {
          fromColumn: fromColumn?.name ?? task.columnId,
          toColumn: targetColumn.name,
        },
      };
      updateSet.autoWakeCount = 0;
      // Clear running flag when moving out of In Progress — prevents ghost
      // tasks that keep consuming agent slots after being moved to Done/Review/Blocked
      if (targetColumn.slug !== 'in_progress') {
        updateSet.running = false;
      }
      updateDoc.$push = { activity: cappedPush(activityEntry, TASK_ACTIVITY_CAP) };
    }

    const result = await this.tasks.findOneAndUpdate(
      { taskId },
      updateDoc,
      { returnDocument: 'after' },
    );

    // Record event to board_events collection
    if (result && isRealMove) {
      const project = await this.projects.findOne({ boardId: board.boardId });
      if (project) {
        await this._recordEvent(board.boardId, project.projectId, project.workspaceId, result, 'moved', actor, {
          fromColumn: fromColumn?.name ?? task.columnId,
          toColumn: targetColumn.name,
        });
      }
    }

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

    // archived is NOT mutated by assign/unassign — assignedAgentId carries that info
    const result = await this.tasks.findOneAndUpdate(
      { taskId },
      {
        $set: {
          assignedAgentId: agentId ?? undefined,
          updatedAt: now,
        },
        $push: { activity: cappedPush(activityEntry, TASK_ACTIVITY_CAP) },
      },
      { returnDocument: 'after' },
    );

    // Record event to board_events collection
    if (result) {
      const board = await this.boards.findOne({ boardId: result.boardId });
      const project = board ? await this.projects.findOne({ projectId: board.projectId }) : null;
      if (board && project) {
        await this._recordEvent(result.boardId, board.projectId, project.workspaceId, result, activityEntry.eventType, actor, activityEntry.details as BoardEventDetails);
      }
    }

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
          updatedAt: now,
        },
        $push: { activity: cappedPush(activityEntries, TASK_ACTIVITY_CAP) },
      },
      { returnDocument: 'after' },
    );

    if (!result) throw new Error(`Failed to update task ${taskId}`);

    // Record events to board_events collection
    const project = await this.projects.findOne({ boardId: board.boardId });
    if (project) {
      for (const entry of activityEntries) {
        await this._recordEvent(board.boardId, project.projectId, project.workspaceId, result, entry.eventType, actor, entry.details as BoardEventDetails);
      }
    }

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
          activity: cappedPush({
            eventType: 'linked' as TaskActivityEventType,
            actor,
            timestamp: now,
            details: { channelId },
          }, TASK_ACTIVITY_CAP),
        },
      },
      { returnDocument: 'after' },
    );

    // Record event to board_events collection
    if (result) {
      const board = await this.boards.findOne({ boardId: result.boardId });
      const project = board ? await this.projects.findOne({ projectId: board.projectId }) : null;
      if (board && project) {
        await this._recordEvent(result.boardId, board.projectId, project.workspaceId, result, 'linked', actor, { channelId });
      }
    }

    return result ?? null;
  }

  /**
   * Archive a task (manager action).
   * Sets archived=true on the task. Archived tasks are out of the active board.
   */
  async archiveTask(
    taskId: string,
    actor: string,
    archiveNote?: string,
  ): Promise<Task | null> {
    const now = new Date().toISOString();
    const $set: Record<string, unknown> = {
      archived: true,
      running: false, // Clear running flag — archived tasks must not consume autoplay slots
      updatedAt: now,
    };

    if (archiveNote) {
      $set.archiveNote = archiveNote;
    }

    const activityEntry: TaskActivityEntry = {
      eventType: 'status_changed',
      actor,
      timestamp: now,
      details: { fromStatus: 'active', toStatus: 'archived' },
    };

    const result = await this.tasks.findOneAndUpdate(
      { taskId },
      { $set, $push: { activity: cappedPush(activityEntry, TASK_ACTIVITY_CAP) } },
      { returnDocument: 'after' },
    );

    // Record event to board_events collection
    if (result) {
      const board = await this.boards.findOne({ boardId: result.boardId });
      const project = board ? await this.projects.findOne({ projectId: board.projectId }) : null;
      if (board && project) {
        await this._recordEvent(result.boardId, board.projectId, project.workspaceId, result, 'task.archived', actor, { archiveNote, fromStatus: 'active', toStatus: 'archived' });
      }
    }

    return result ?? null;
  }

  /**
   * Unarchive a task (manager action).
   * Sets archived=false, making it active again on the board.
   */
  async unarchiveTask(
    taskId: string,
    actor: string,
  ): Promise<Task | null> {
    const now = new Date().toISOString();

    const activityEntry: TaskActivityEntry = {
      eventType: 'status_changed',
      actor,
      timestamp: now,
      details: { fromStatus: 'archived', toStatus: 'active' },
    };

    const result = await this.tasks.findOneAndUpdate(
      { taskId },
      {
        $set: { archived: false, updatedAt: now },
        $push: { activity: cappedPush(activityEntry, TASK_ACTIVITY_CAP) },
      },
      { returnDocument: 'after' },
    );

    // Record event to board_events collection
    if (result) {
      const board = await this.boards.findOne({ boardId: result.boardId });
      const project = board ? await this.projects.findOne({ projectId: board.projectId }) : null;
      if (board && project) {
        await this._recordEvent(result.boardId, board.projectId, project.workspaceId, result, 'task.unarchived', actor, { fromStatus: 'archived', toStatus: 'active' });
      }
    }

    return result ?? null;
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
        // A progress note is real progress → reset the autoplay stuck counter
        // (TER-650/G2).
        $set: { updatedAt: now, autoWakeCount: 0 },
        $push: {
          progressNotes: cappedPush(note, TASK_PROGRESS_NOTES_CAP),
          activity: cappedPush(activityEntry, TASK_ACTIVITY_CAP),
        },
      },
      { returnDocument: 'after' },
    );

    // Record event to board_events collection
    if (result) {
      const board = await this.boards.findOne({ boardId: result.boardId });
      const project = board ? await this.projects.findOne({ projectId: board.projectId }) : null;
      if (board && project) {
        await this._recordEvent(result.boardId, board.projectId, project.workspaceId, result, 'progress_note', actor, { note: text });
      }
    }

    return result ?? null;
  }

  /**
   * Get all active tasks in a board that depend on the given task.
   * Used when cancelling a task to find tasks that will be left orphaned.
   * Only returns non-archived tasks (archived dependents don't need notification).
   */
  async getDependentTasks(taskId: string, boardId: string): Promise<Task[]> {
    return this.tasks
      .find({ boardId, dependencies: taskId, archived: { $ne: true } })
      .toArray();
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
   * Set the running flag on a task.
   *
   * Returns the updated task if the flag actually changed, or null if:
   * - Task not found
   * - Flag was already at the desired value (no-op)
   *
   * @param actor — who is changing the running flag. Defaults to 'system'
   *   for backward compatibility, but callers should pass the agent ID
   *   (e.g. `task.assignedAgentId`) so the activity log attributes the
   *   change to the agent, not to System.
   */
  async setRunning(taskId: string, running: boolean, actor: string = 'system'): Promise<Task | null> {
    const task = await this.tasks.findOne({ taskId });
    if (!task) return null;

    // No-op if already in the desired state
    if (task.running === running) return null;

    const now = new Date().toISOString();

    const $set: Record<string, unknown> = { running, updatedAt: now };

    const result = await this.tasks.findOneAndUpdate(
      { taskId },
      {
        $set,
        $push: {
          activity: cappedPush({
            eventType: 'running_changed' as const,
            actor,
            timestamp: now,
            details: { running },
          }, TASK_ACTIVITY_CAP),
        },
      },
      { returnDocument: 'after' },
    );

    return result ?? null;
  }

  /**
   * Clear the cooperative stop flags (stopRequested, stopRequestedAt, stopRequestedBy).
   *
   * Called when a task transitions out of a state where the stop signal is
   * meaningful — e.g. complete-my-task (task is now in Review, the stop is
   * resolved) or cancel-my-task (task archived, stop no longer applies).
   *
   * Returns the updated task, or null if the task was not found / had no
   * stop flag set (no-op).
   */
  async clearStopRequest(taskId: string): Promise<Task | null> {
    const task = await this.tasks.findOne({ taskId });
    if (!task) return null;
    // No-op if no stop was requested.
    if (!task.stopRequested) return task;

    const now = new Date().toISOString();
    const result = await this.tasks.findOneAndUpdate(
      { taskId },
      {
        $set: { updatedAt: now },
        $unset: { stopRequested: '', stopRequestedAt: '', stopRequestedBy: '' },
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
        // resolveAgents es un resolver de PRESENTACIÓN (lo consumen ~8 boundaries
        // de salida: board-commands, get-board, get-task, list-tasks, queries
        // board-read). Resolver aquí cubre todos de raíz y elimina la asimetría.
        avatarUrl: buildAvatarUrl(a.avatarUrl),
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

      // Circular dependency is a technical error — do NOT mutate archived status.
      // Just log and throw so the caller can surface the error to the user.
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
          activity: cappedPush({
            eventType: 'dependency_added' as const,
            actor,
            timestamp: now,
            details: { note: `Added dependency on ${dependsOnTaskId}` },
          }, TASK_ACTIVITY_CAP),
        },
      },
      { returnDocument: 'after' },
    );

    if (!result) throw new Error(`Failed to update task ${taskId}`);
    return result;
  }

  /**
   * Remove a dependency: taskId no longer depends on dependsOnTaskId.
   * This operation is idempotent — if the dependency does not exist, the task is returned unchanged.
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
          activity: cappedPush({
            eventType: 'dependency_removed' as const,
            actor,
            timestamp: now,
            details: { note: `Removed dependency on ${dependsOnTaskId}` },
          }, TASK_ACTIVITY_CAP),
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
/**
 * Unified system sender for all platform-generated messages (task start via
 * autoplay, manual start-task, or MCA board-start). Always use this — no
 * fallbacks, no getUserSender() calls. The `role` field stays 'user' (it's
 * the LLM protocol role); `sender` is the display identity.
 */
export const SYSTEM_SENDER = { type: 'system' as const, id: 'teros', name: 'Teros' };

/**
 * Unified initial message builder for board tasks — used by both the manual
 * start-task handler and the autoplay service. The agent receives this as a
 * regular user message in its conversation channel.
 */
export function buildTaskInitialMessage(task: {
  taskId: string;
  title: string;
  description?: string;
  instructions?: string;
  priority?: string;
  tags?: unknown;
  input?: { schemaId?: string | null; data?: unknown } | null;
}, customPrompt?: string, boardRunnerAppName: string = 'boards'): string {
  // This instruction is always appended — even to custom prompts — to enforce
  // the no-delegation rule for all board task execution contexts.
  const noDelegationNote =
    `\n\n> **Board task execution context:** Do NOT use \`conversations_delegate-task\` or any delegation tool. Execute all work directly in this conversation.`;

  // This instruction is always appended — even to custom prompts — so the agent
  // knows it can retrieve full task details (instructions, status, progress notes)
  // at any time via the board-runner get-my-task tool.
  const getMyTaskNote =
    `\n\n> **Task details:** Use \`${boardRunnerAppName}_get-my-task\` to view the full task details (title, description, instructions, priority, tags, status, and progress notes) at any time.`;

  // Conditional input note — appended when the task carries an input artifact
  // (event payload, upstream workflow data, …). Tells the agent where to read it.
  const hasInput = task.input?.data !== undefined && task.input?.data !== null;
  const workflowInputNote = hasInput
    ? `\n\n> **Input:** This task has an input artifact${task.input?.schemaId ? ` (type \`${task.input.schemaId}\`)` : ''}. Use \`${boardRunnerAppName}_get-my-task\` to read the full \`input\` (schema + data).`
    : '';

  if (customPrompt) return customPrompt + getMyTaskNote + workflowInputNote + noDelegationNote;

  const taskDescription = task.instructions || task.description || 'No description provided.';

  // Conditional Workflow Input section for the standard message body.
  const workflowInputSection = hasInput
    ? [
        ``,
        `## Input`,
        `This task has an input artifact${task.input?.schemaId ? ` of type \`${task.input.schemaId}\`` : ''}. Use \`${boardRunnerAppName}_get-my-task\` to read the full \`input\` (schema + data) — it is what this task has to process.`,
        ``,
      ].join('\n')
    : '';

  return [
    `You have been assigned a task. Execute it autonomously.`,
    ``,
    `## Task: ${task.title}`,
    `**Priority:** ${task.priority || 'medium'}`,
    `**Tags:** ${normalizeTags(task.tags).join(', ') || 'none'}`,
    ``,
    `## Description`,
    taskDescription,
    workflowInputSection,
    `## Instructions`,
    `- Use \`${boardRunnerAppName}_get-my-task\` to view the full task details (title, description, instructions, priority, tags, status, and progress notes) at any time.`,
    `- Work autonomously. If tools require user approval, the user will be notified.`,
    `- **After each significant step, add a progress note** with \`${boardRunnerAppName}_add-progress-note\` (taskId: \`${task.taskId}\`). Write notes in clear, accessible language — the same tone as the task description. Explain what you did, what you found, and what comes next. These notes are how the operator follows your work, so they are essential.`,
    `- When you finish, move this task to the Review or Done column using \`${boardRunnerAppName}_move-my-task\`.`,
    `- If you cannot complete the task, set status to \`blocked\` and add a progress note explaining why.`,
    `- If you hit the execution limit (tool calls blocked), add a progress note summarizing what you accomplished and what remains. This resets your execution counter so you can continue working.`,
    `- **Do NOT use \`conversations_delegate-task\` or any delegation tool.** Execute all work directly in this conversation.`,
  ].join('\n');
}
