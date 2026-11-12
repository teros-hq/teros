/**
 * Board Bridge — Abstraction layer between the Workflow Engine and the Teros Board.
 *
 * The engine uses this interface to create tasks on the board and retrieve their
 * status/output. This decouples the engine from the concrete board implementation.
 *
 * - InMemoryBoardBridge — for unit tests (no MongoDB or board-service needed)
 * - A production implementation would wrap the board-service createTask/getTask calls
 *
 * Design doc: /opt/teros/docs/workflows/DESIGN.md
 */

import type { Gate, ArtifactSchema } from '../models/types';

// ============================================================================
// CREATE TASK PARAMETERS
// ============================================================================

/**
 * Parameters for creating a task on the board via the bridge.
 *
 * Maps to the board-service CreateTaskInput, including the workflow extension
 * fields added in WF2 (workflowInputGate, workflowOutputGate, etc.).
 */
/**
 * A typed value attached to a task (its input or its deliverable). Owned by the
 * task, not by the workflow — see docs/specs/tasks/artifacts.md.
 */
export interface TaskArtifact {
  /** Artifact type id — null when untyped; "markdown" is the built-in free-text type. */
  schemaId: string | null;
  /** Snapshot of the artifact schema at creation time. */
  schema?: ArtifactSchema;
  /** The value. */
  data?: unknown;
}

export interface CreateTaskParams {
  /** Project board to create the task on */
  projectId: string;

  /** Task title (typically the node's label) */
  title: string;

  /** Short description (typically the node's description) */
  description: string;

  /** Detailed instructions (interpolated with {{variables}} from input data) */
  instructions: string;

  /** Task priority */
  priority: 'urgent' | 'high' | 'medium' | 'low';

  /** Tags for categorization (engine adds workflow-related tags) */
  tags: string[];

  /** Agent to assign the task to (undefined for human tasks) */
  assignedAgentId?: string;

  /**
   * Target column ID for the created task.
   * If not set or invalid, the board defaults to its first column (Backlog).
   * Read from node.data.targetColumn by the action handler.
   */
  targetColumnId?: string;

  // --- Workflow extension fields (from WF2: WorkflowTaskExtensions) ---

  /** Input gate — routing metadata of the node */
  workflowInputGate?: Gate;

  /** Output gate — routing metadata of the node */
  workflowOutputGate?: Gate;

  /** Input artifact of the task: the upstream gate data, typed by the input gate's artifact. */
  input?: TaskArtifact;

  /** Output artifact the task must deliver: type + schema snapshot of the output gate's artifact. */
  output?: TaskArtifact;

  /** Reference to the workflow execution that created this task */
  workflowExecutionId?: string;

  /** Reference to the workflow node that created this task */
  workflowNodeId?: string;
}

// ============================================================================
// TASK INFO
// ============================================================================

/**
 * Information about a board task, returned by the bridge.
 */
export interface TaskInfo {
  taskId: string;

  /** Task status on the board (e.g., 'backlog', 'in_progress', 'review', 'done') */
  status: string;

  /** Output data produced by the task (the deliverable) */
  outputData?: unknown;
}

// ============================================================================
// BOARD BRIDGE INTERFACE
// ============================================================================

/**
 * Board Bridge — the interface the Workflow Engine uses to interact with the board.
 *
 * Methods:
 * - createTask: Create a task on the board for a workflow action node
 * - getTask: Retrieve a task's status and output data
 */
export interface BoardBridge {
  /**
   * Create a task on the board.
   * @returns The created task's ID
   */
  createTask(params: CreateTaskParams): Promise<{ taskId: string }>;

  /**
   * Get a task's current status and output data.
   * @returns Task info, or null if the task doesn't exist
   */
  getTask(taskId: string): Promise<TaskInfo | null>;
}
