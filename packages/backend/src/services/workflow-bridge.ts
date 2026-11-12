/**
 * Production Board Bridge & Board Control — adapters that connect the
 * Workflow Engine to the Teros Board via BoardService.
 *
 * - `BoardServiceBridge` implements the `BoardBridge` interface (createTask, getTask)
 *   so the engine can create board tasks for action nodes and read their status.
 *
 * - `BoardServiceControl` implements the `BoardControl` interface (moveTaskBySlug,
 *   addProgressNote) so the ActionBridge can reject tasks (move them back when
 *   output validation fails).
 *
 * These are the production counterparts of InMemoryBoardBridge.
 */

import type { BoardService } from './board-service';
import type { PubSubService } from './pubsub-service';
import type { Task, TaskArtifact } from '../types/database';
import type {
  BoardBridge,
  CreateTaskParams,
  TaskInfo,
} from '@teros/workflows/bridge';
import type { BoardControl } from '@teros/workflows/bridge';

// ============================================================================
// BOARD SERVICE BRIDGE — Engine → Board (create tasks, read status)
// ============================================================================

/** Real-time fan-out to board windows; every task writer broadcasts on `board:<boardId>`. */
type BoardBroadcaster = Pick<PubSubService, 'broadcastToTopic'> | null | undefined;

export class BoardServiceBridge implements BoardBridge {
  constructor(
    private boardService: BoardService,
    private pubSubService?: BoardBroadcaster,
  ) {}

  async createTask(params: CreateTaskParams): Promise<{ taskId: string }> {
    // Resolve the board for this project
    const board = await this.boardService.getBoardByProject(params.projectId);
    if (!board) {
      throw new Error(`[BoardServiceBridge] Board not found for project ${params.projectId}`);
    }

    // Resolve the target column: use the specified columnId, or fall back to
    // the board's default (first column = Backlog) when not set.
    let columnId = params.targetColumnId;
    if (columnId) {
      // Validate that the column exists on this board
      const colExists = board.columns.some((c) => c.columnId === columnId);
      if (!colExists) {
        console.warn(`[BoardServiceBridge] Column ${columnId} not found on board ${board.boardId}, falling back to default`);
        columnId = undefined;
      }
    }

    const task = await this.boardService.createTask(board.boardId, 'system:workflow', {
      title: params.title,
      description: params.description,
      instructions: params.instructions,
      priority: params.priority,
      tags: params.tags,
      assignedAgentId: params.assignedAgentId,
      columnId,
      // Workflow extension fields
      workflowInputGate: params.workflowInputGate as Record<string, unknown> | undefined,
      workflowOutputGate: params.workflowOutputGate as Record<string, unknown> | undefined,
      // The workflows package types the schema snapshot as ArtifactSchema; the
      // board stores it as opaque JSON.
      input: params.input as unknown as TaskArtifact | undefined,
      output: params.output as unknown as TaskArtifact | undefined,
      workflowExecutionId: params.workflowExecutionId,
      workflowNodeId: params.workflowNodeId,
    });

    this.pubSubService?.broadcastToTopic(`board:${board.boardId}`, {
      type: 'board_task_created',
      task,
      boardId: board.boardId,
    });

    return { taskId: task.taskId };
  }

  async getTask(taskId: string): Promise<TaskInfo | null> {
    const task: Task | null = await this.boardService.getTask(taskId);
    if (!task) return null;

    // Map the board column to a status slug
    const board = await this.boardService.getBoard(task.boardId);
    const column = board?.columns.find((c) => c.columnId === task.columnId);

    return {
      taskId: task.taskId,
      status: column?.slug ?? 'unknown',
      outputData: task.output?.data,
    };
  }
}

// ============================================================================
// BOARD SERVICE CONTROL — ActionBridge → Board (reject tasks, add notes)
// ============================================================================

export class BoardServiceControl implements BoardControl {
  constructor(
    private boardService: BoardService,
    private pubSubService?: BoardBroadcaster,
  ) {}

  async moveTaskBySlug(
    taskId: string,
    columnSlug: string,
  ): Promise<{ taskId: string; status: string } | null> {
    const task = await this.boardService.getTask(taskId);
    if (!task) return null;

    const board = await this.boardService.getBoard(task.boardId);
    if (!board) return null;

    const targetColumn = board.columns.find((c) => c.slug === columnSlug);
    if (!targetColumn) {
      console.error(`[BoardServiceControl] Column with slug '${columnSlug}' not found on board ${task.boardId}`);
      return null;
    }

    const moved = await this.boardService.moveTask(taskId, 'system:workflow', targetColumn.columnId);
    if (!moved) return null;

    this.pubSubService?.broadcastToTopic(`board:${moved.boardId}`, { type: 'board_task_updated', task: moved });

    return { taskId: moved.taskId, status: columnSlug };
  }

  async addProgressNote(taskId: string, text: string): Promise<void> {
    const updated = await this.boardService.addProgressNote(taskId, text, 'system:workflow');
    if (updated) {
      this.pubSubService?.broadcastToTopic(`board:${updated.boardId}`, { type: 'board_task_updated', task: updated });
    }
  }
}
