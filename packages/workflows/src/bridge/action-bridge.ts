/**
 * Action Bridge — Connects board task lifecycle with the Workflow Engine.
 *
 * This is the bidirectional bridge between the Teros Board and the Workflow Engine:
 *
 * - `onTaskCompleted(task)` — Called when a board task is moved to 'review' or 'done'.
 *   If the task has `workflowExecutionId`, the bridge notifies the engine to advance
 *   the workflow. If the engine rejects the output (gate validation fails), the bridge
 *   rejects the task (moves it back to 'in_progress' or 'blocked').
 *
 * - `onTaskCreated(node, executionId, taskId)` — Called by the engine when it creates
 *   a task for an action node. This is the reverse direction: the engine creates the
 *   task via the BoardBridge, and the action bridge records the linkage.
 *
 * The ActionBridge is designed to be injected into the board handlers (complete-my-task,
 * move-task) so that workflow-linked tasks automatically trigger engine advancement
 * without the board handlers needing to know about workflows.
 *
 * Design doc: /opt/teros/docs/workflows/DESIGN.md
 */

import type { WorkflowEngine } from '../engine/workflow-engine';
import type { AdvanceExecutionResult } from '../engine/types';
import type { WorkflowNode } from '../models/types';

// ============================================================================
// TASK LIFECYCLE EVENT — What the board sends to the bridge
// ============================================================================

/**
 * Minimal task representation that the board sends to the bridge.
 *
 * This is intentionally loose — it matches the fields the backend's Task type
 * has (including the WF2 workflow extensions), but doesn't import the backend
 * types directly. The bridge only needs to know:
 * - taskId: which task completed
 * - workflowExecutionId: which execution to advance (if any)
 * - workflowNodeId: which node the task corresponds to
 * - outputData: the output data produced by the task (task.output.data)
 * - status: the current board status of the task
 */
export interface TaskCompletionEvent {
  taskId: string;
  /** Board column slug (e.g., 'review', 'done', 'in_progress', 'blocked') */
  status: string;
  /** Workflow execution ID — if absent, the task is not workflow-linked */
  workflowExecutionId?: string;
  /** Workflow node ID — the node that created this task */
  workflowNodeId?: string;
  /** Output data produced by the task (the deliverable, `task.output.data`) */
  outputData?: unknown;
}

// ============================================================================
// BRIDGE RESULT TYPES
// ============================================================================

/**
 * Result of `onTaskCompleted` — describes what happened.
 */
export interface TaskCompletedResult {
  /** True if the task was workflow-linked and the engine was notified */
  bridged: boolean;
  /** True if the engine accepted the output and advanced the workflow */
  advanced: boolean;
  /** True if the engine rejected the output (gate validation failed) */
  rejected: boolean;
  /** Validation errors if the output was rejected */
  validationErrors?: string[];
  /** The engine result if the workflow advanced */
  engineResult?: AdvanceExecutionResult;
  /** Error message if the bridge itself failed (not a validation error) */
  error?: string;
}

/**
 * Result of `onTaskCreated` — records the task↔node linkage.
 */
export interface TaskCreatedResult {
  taskId: string;
  executionId: string;
  nodeId: string;
}

// ============================================================================
// REJECTION STRATEGY
// ============================================================================

/**
 * Where to send a task when its output is rejected by the workflow gate.
 *
 * - 'in_progress': The task goes back to In Progress so the agent can revise.
 * - 'blocked': The task is blocked, requiring manual intervention.
 *
 * Default: 'in_progress' — gives the agent a chance to fix the output.
 */
export type RejectionStrategy = 'in_progress' | 'blocked';

// ============================================================================
// BOARD CONTROL INTERFACE
// ============================================================================

/**
 * Minimal interface for moving tasks on the board.
 *
 * The ActionBridge uses this to reject tasks (move them back when output
 * validation fails). In production, this wraps the BoardService.moveTask method.
 * In tests, a simple in-memory implementation suffices.
 */
export interface BoardControl {
  /**
   * Move a task to a different column (by slug).
   * @returns The updated task, or null if the move failed
   */
  moveTaskBySlug(taskId: string, columnSlug: string): Promise<{ taskId: string; status: string } | null>;

  /**
   * Add a progress note to a task (to explain why it was rejected).
   */
  addProgressNote?(taskId: string, text: string): Promise<void>;
}

// ============================================================================
// ACTION BRIDGE
// ============================================================================

/**
 * Action Bridge — connects board task completion to workflow engine advancement.
 *
 * Usage in board handlers:
 * ```typescript
 * const actionBridge = new ActionBridge({ engine, boardControl });
 *
 * // In complete-my-task handler, after moving the task to Review:
 * const result = await actionBridge.onTaskCompleted(task);
 * if (result.rejected) {
 *   // Task was moved back to in_progress/blocked by the bridge
 * }
 * ```
 *
 * Usage in the engine (reverse direction):
 * ```typescript
 * // When the engine creates a task for an action node:
 * const result = await actionBridge.onTaskCreated(node, executionId, taskId);
 * ```
 */
export class ActionBridge {
  private engine: WorkflowEngine;
  private boardControl: BoardControl | null;
  private rejectionStrategy: RejectionStrategy;

  constructor(config: {
    engine: WorkflowEngine;
    /** Board control for rejecting tasks. Optional — if null, rejections are reported but not enacted. */
    boardControl?: BoardControl | null;
    /** Where to send rejected tasks (default: 'in_progress') */
    rejectionStrategy?: RejectionStrategy;
  }) {
    this.engine = config.engine;
    this.boardControl = config.boardControl ?? null;
    this.rejectionStrategy = config.rejectionStrategy ?? 'in_progress';
  }

  // ==========================================================================
  // ON TASK COMPLETED — Board → Engine
  // ==========================================================================

  /**
   * Called when a board task is completed (moved to 'review' or 'done').
   *
   * If the task has a `workflowExecutionId`:
   * 1. Extract the output data from the task
   * 2. Call `engine.advanceExecution(executionId, taskId, outputData)`
   * 3. If the engine reports validation errors → reject the task (move it back)
   * 4. If the engine advances successfully → return the result
   *
   * If the task has no `workflowExecutionId`, this is a no-op (the task is
   * not workflow-linked, so the board handles it normally).
   *
   * @param event - The task completion event from the board
   * @returns Result describing what happened
   */
  async onTaskCompleted(event: TaskCompletionEvent): Promise<TaskCompletedResult> {
    // Not a workflow task — no-op
    if (!event.workflowExecutionId) {
      return { bridged: false, advanced: false, rejected: false };
    }

    // Defense-in-depth: only 'review' and 'done' represent task completion.
    // Other statuses (e.g., 'in_progress', 'blocked', 'todo') mean the task
    // is still being worked on — advancing the workflow would be premature
    // and could duplicate Split branches if advanceExecution is called
    // again when the task is actually completed.
    if (event.status !== 'review' && event.status !== 'done') {
      return { bridged: false, advanced: false, rejected: false };
    }

    const { taskId, workflowExecutionId, outputData } = event;

    try {
      // Notify the engine to advance the workflow
      const engineResult = await this.engine.advanceExecution(
        workflowExecutionId,
        taskId,
        outputData,
      );

      // Check if the engine rejected the output (validation errors)
      if (engineResult.validationErrors && engineResult.validationErrors.length > 0) {
        // Output didn't pass the gate — reject the task
        await this.rejectTask(taskId, engineResult.validationErrors);
        return {
          bridged: true,
          advanced: false,
          rejected: true,
          validationErrors: engineResult.validationErrors,
          engineResult,
        };
      }

      // Success — the workflow advanced
      return {
        bridged: true,
        advanced: true,
        rejected: false,
        engineResult,
      };
    } catch (err) {
      // The engine threw an error (not a validation error, but a system error)
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Try to reject the task so the agent knows something went wrong
      await this.rejectTask(taskId, [`Workflow engine error: ${errorMsg}`]);

      return {
        bridged: true,
        advanced: false,
        rejected: true,
        error: errorMsg,
      };
    }
  }

  // ==========================================================================
  // ON TASK CREATED — Engine → Board (reverse direction)
  // ==========================================================================

  /**
   * Called by the engine when it creates a task for a workflow action node.
   *
   * This records the linkage between the task and the workflow node.
   * In a full implementation, this could also notify subscribers or log metrics.
   *
   * @param node - The workflow node that created the task
   * @param executionId - The workflow execution ID
   * @param taskId - The board task ID that was created
   * @returns The task creation result
   */
  async onTaskCreated(
    node: WorkflowNode,
    executionId: string,
    taskId: string,
  ): Promise<TaskCreatedResult> {
    return {
      taskId,
      executionId,
      nodeId: node.nodeId,
    };
  }

  // ==========================================================================
  // INTERNAL: REJECT A TASK
  // ==========================================================================

  /**
   * Reject a task by moving it back to in_progress or blocked,
   * and adding a progress note explaining why.
   */
  private async rejectTask(taskId: string, errors: string[]): Promise<void> {
    if (!this.boardControl) {
      // No board control — can't move the task, just log
      console.warn(
        `[ActionBridge] Task ${taskId} rejected (output validation failed), ` +
          `but no boardControl configured to move it back. Errors: ${errors.join('; ')}`,
      );
      return;
    }

    try {
      const targetSlug = this.rejectionStrategy === 'blocked' ? 'blocked' : 'in_progress';
      const moved = await this.boardControl.moveTaskBySlug(taskId, targetSlug);

      if (!moved) {
        console.error(
          `[ActionBridge] Failed to move rejected task ${taskId} to '${targetSlug}'`,
        );
        return;
      }

      // Add a progress note explaining the rejection (if supported)
      if (this.boardControl.addProgressNote) {
        const noteText =
          `⚠️ Workflow output rejected: ${errors.join('; ')}. ` +
          `Please revise the output to match the expected gate and complete the task again.`;
        await this.boardControl.addProgressNote(taskId, noteText);
      }
    } catch (err) {
      console.error(
        `[ActionBridge] Error while rejecting task ${taskId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
