/**
 * Workflow Engine Types
 *
 * Type definitions for the engine's public API: execution results, step results,
 * and status summaries.
 */

import type { Execution, ExecutionStep, WorkflowNode, ArtifactSchema } from '../models/types';
import type { ToolExecutor } from '../handlers/tool-executor';

// ============================================================================
// START EXECUTION RESULT
// ============================================================================

/**
 * Result of starting an execution.
 *
 * - `execution`: The created execution document
 * - `steps`: All steps created during the initial cascade (start node + any
 *            non-action nodes that were processed immediately)
 * - `pendingTaskIds`: Task IDs that were created for action nodes and are
 *                     waiting for completion. The caller should monitor these
 *                     and call `advanceExecution` when they complete.
 */
export interface StartExecutionResult {
  execution: Execution;
  steps: ExecutionStep[];
  pendingTaskIds: string[];
}

// ============================================================================
// ADVANCE EXECUTION RESULT
// ============================================================================

/**
 * Result of advancing an execution (after a task completes).
 *
 * - `execution`: The updated execution document
 * - `completedStep`: The step that was completed (the one associated with the task)
 * - `newSteps`: New steps created during the cascade from the completed node
 * - `pendingTaskIds`: New task IDs waiting for completion (from new action nodes)
 * - `validationErrors`: Gate validation errors if the output was rejected
 */
export interface AdvanceExecutionResult {
  execution: Execution;
  completedStep: ExecutionStep;
  newSteps: ExecutionStep[];
  pendingTaskIds: string[];
  validationErrors?: string[];
}

// ============================================================================
// EXECUTION STATUS
// ============================================================================

/**
 * Detailed status of an execution, including all steps and a summary.
 *
 * Returned by `getExecutionStatus()`.
 */
export interface ExecutionStatusResult {
  execution: Execution;
  steps: ExecutionStep[];
  summary: {
    totalSteps: number;
    completed: number;
    running: number;
    pending: number;
    failed: number;
    blocked: number;
    /** True when all steps are completed and the execution is done */
    allCompleted: boolean;
  };
}

// ============================================================================
// ENGINE CONFIG
// ============================================================================

/**
 * Configuration for creating a WorkflowEngine instance.
 */
export interface WorkflowEngineConfig {
  /** Store for persisting executions and steps */
  store: import('./store').WorkflowStore;
  /** Bridge for creating/reading tasks on the board */
  bridge: import('../bridge/types').BoardBridge;
  /**
   * Default project ID for creating tasks on the board.
   * Can be overridden by Flow.projectId or WorkflowNode.projectId.
   * If not set and the flow doesn't specify one, action nodes will fail
   * with a clear error message.
   */
  projectId?: string;
  /** Default priority for created tasks (default: 'medium') */
  defaultPriority?: 'urgent' | 'high' | 'medium' | 'low';
  /**
   * Optional function to resolve artifact schemas by schemaId.
   * The engine uses this to resolve gate.schemaId → ArtifactSchema
   * for validation. If not provided, validation skips schema resolution
   * (signal-only gates still pass; artifact-referencing gates will fail).
   */
  resolveSchema?: (schemaId: string) => Promise<ArtifactSchema | null>;
  /**
   * Optional tool executor for function nodes to call MCA tools.
   * If not provided, function nodes that try to call tools will get
   * an error from the NoopToolExecutor.
   */
  toolExecutor?: ToolExecutor;
  /**
   * Optional list of available tool names for the workspace.
   * Populated by the backend from the workspace's installed apps.
   */
  availableTools?: string[];
  /** User ID executing the workflow (passed to function node tool calls) */
  userId?: string;
  /** Agent ID executing the workflow (passed to function node tool calls) */
  agentId?: string;
  /** Channel ID (passed to function node tool calls) */
  channelId?: string;
}

// ============================================================================
// INTERNAL TYPES
// ============================================================================

/**
 * Result of processing a single node.
 *
 * - `completed`: The node was fully processed (no task needed)
 * - `paused`: The node created a task and is waiting for completion
 * - `failed`: The node failed (validation error or other)
 */
export interface SplitBranch {
  /** Zero-based index of this branch within the split array */
  branchIndex: number;
  /** The single array item this branch carries */
  item: unknown;
}

export interface NodeProcessResult {
  status: 'completed' | 'paused' | 'failed' | 'blocked';
  taskId?: string;
  outputData?: Record<string, unknown>;
  error?: string;
  /** Node IDs to cascade to (outgoing edges to follow) */
  nextNodeIds?: string[];
  /**
   * Split fan-out branches — only set by the Split node handler.
   *
   * When present, the engine creates one step per branch (instead of one
   * step per nextNodeIds entry). Each branch gets a unique branchId, and
   * the branch's `item` is passed as input data to the downstream node.
   *
   * The number of branches = the length of the input array.
   */
  branches?: SplitBranch[];
  /**
   * Branch ID that arrived at a Join node — set by the Join handler.
   *
   * The engine uses this to update the Join step's arrivedBranchIds array.
   * Only meaningful when status is 'blocked' (branch arrived but not all
   * branches yet) or 'completed' (last branch arrived, Join fires).
   */
  arrivedBranchId?: string;
  /**
   * Whether this Join node step has collected all expected branches.
   *
   * Set to true by the Join handler when arrivedBranchIds.length === expectedCount.
   * The engine uses this to know whether to cascade downstream after a Join.
   */
  joinCompleted?: boolean;
}

/**
 * Context passed to node handlers.
 */
export interface NodeHandlerContext {
  executionId: string;
  flowId: string;
  workspaceId: string;
  node: WorkflowNode;
  step: ExecutionStep;
  /** Input data for this node's gates (keyed by gateId) */
  inputData: Record<string, unknown>;
  /** Trigger data (available to start nodes) */
  triggerData?: unknown;
  /** The store for persisting step updates */
  store: import('./store').WorkflowStore;
  /** The bridge for creating tasks */
  bridge: import('../bridge/types').BoardBridge;
  /** Project ID for task creation */
  projectId: string;
  /** Default priority for tasks */
  defaultPriority: 'urgent' | 'high' | 'medium' | 'low';
  /** Resolved artifact schemas for gate validation (schemaId → ArtifactSchema) */
  schemaMap?: Map<string, ArtifactSchema> | null;
  /** Tool executor for function nodes to call MCA tools */
  toolExecutor?: ToolExecutor;
  /** Available tool names for the workspace (for function node sandbox) */
  availableTools?: string[];
  /** User ID executing the workflow (for tool call context) */
  userId?: string;
  /** Agent ID executing the workflow (for tool call context) */
  agentId?: string;
  /** Channel ID (for tool call context) */
  channelId?: string;

  /**
   * Branch ID — which split branch this node is being processed in.
   * Undefined for the "trunk" path (before any split).
   * Set by the engine when cascading from a Split node.
   */
  branchId?: string;
}

// ============================================================================
// STRUCTURED ERROR — user-friendly errors with code + suggestion
// ============================================================================

/**
 * Structured error thrown by the WorkflowEngine.
 *
 * Carries a machine-readable `code`, a human-friendly `message`, and an
 * optional `suggestion` that tells the user how to fix the problem.
 * The MCA layer catches these and forwards the structured fields to the
 * UI so the user sees a clear, actionable error instead of a raw string.
 */
export class WorkflowError extends Error {
  constructor(
    public code: string,
    message: string,
    public suggestion?: string,
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}
