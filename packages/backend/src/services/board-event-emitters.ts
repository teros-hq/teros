/**
 * Board event emitters — shared builders for board subscription events
 * (bug fb_d211b16343bd3034, 2026-10-23).
 *
 * Board mutations run through TWO execution paths:
 *   1. WS domain handlers (handlers/domains/board/*.ts) — emit subscription
 *      events via BoardSubscriptionService.notifySubscribers.
 *   2. MCA inline query paths (mca-connection-manager.queries-board-*.ts) —
 *      the path every agent tool call actually takes. These implemented the
 *      same mutations with boardService.* but never emitted subscription
 *      events, so subscribed channels got ZERO wakes for progress notes,
 *      moves, assignments, updates, creates, archives and dependency changes
 *      (the matcher and the taskIds filter were fine — the events never fired).
 *
 * This module is the single source of truth for event payloads emitted from
 * the MCA paths. Each builder mirrors — field for field — the payload of the
 * corresponding domain handler (referenced in each JSDoc). If you change a
 * payload here, change the domain handler too (or migrate it to this builder).
 *
 * All emitters are fire-and-forget (notifySubscribers never throws to the
 * caller) and take the task snapshot returned by the mutation, raw and
 * non-enriched — exactly what the domain handlers pass.
 */

import { BoardSubscriptionService, type BoardEventPayload } from './board-subscription-service';
import type { BoardEventType } from '../types/database';

/**
 * Who caused the event — exactly one of the two, mirroring domain handlers.
 * `actorAgentId` is consumed by the self-wake guard in event-handler: an agent
 * must not be woken by an event it produced itself.
 */
export interface BoardEventActor {
  actorAgentId?: string;
  actorUserId?: string;
}

/**
 * Structural slice of a task document the emitters need. Accepts any task
 * returned by BoardService mutations.
 */
export interface TaskLike {
  taskId: string;
  title: string;
  boardId: string;
  assignedAgentId?: string | null;
  tags?: string[];
  columnId?: string;
}

function notify(
  bss: BoardSubscriptionService,
  boardId: string,
  eventType: BoardEventType,
  payload: BoardEventPayload,
): void {
  bss.notifySubscribers(boardId, {
    eventType,
    boardId,
    formattedMessage: BoardSubscriptionService.formatEventMessage({ eventType, boardId, payload }),
    payload,
  });
}

/**
 * board.task_progress_note
 * Payload mirrors handlers/domains/board/add-my-progress-note.ts and
 * add-progress-note.ts: taskId, taskTitle, assignedAgentId, tags, columnId,
 * noteText + actor.
 */
export function emitTaskProgressNote(
  bss: BoardSubscriptionService,
  task: TaskLike,
  noteText: string,
  actor: BoardEventActor,
): void {
  const payload: BoardEventPayload = {
    taskId: task.taskId,
    taskTitle: task.title,
    assignedAgentId: task.assignedAgentId ?? undefined,
    tags: task.tags,
    columnId: task.columnId,
    noteText,
    ...actor,
  };
  notify(bss, task.boardId, 'board.task_progress_note', payload);
}

/** Column context for a task move — ids plus optional display names. */
export interface TaskMovedColumns {
  fromColumnId: string;
  fromColumnName?: string;
  toColumnId: string;
  toColumnName?: string;
}

/**
 * board.task_moved
 * Payload mirrors handlers/domains/board/move-task.ts, move-my-task.ts,
 * complete-my-task.ts and block-my-task.ts: taskId, taskTitle,
 * assignedAgentId, tags, fromColumnId/Name, toColumnId/Name, columnId
 * (the destination) + actor.
 */
export function emitTaskMoved(
  bss: BoardSubscriptionService,
  task: TaskLike,
  columns: TaskMovedColumns,
  actor: BoardEventActor,
): void {
  const payload: BoardEventPayload = {
    taskId: task.taskId,
    taskTitle: task.title,
    assignedAgentId: task.assignedAgentId ?? undefined,
    tags: task.tags,
    fromColumnId: columns.fromColumnId,
    fromColumnName: columns.fromColumnName,
    toColumnId: columns.toColumnId,
    toColumnName: columns.toColumnName,
    columnId: columns.toColumnId,
    ...actor,
  };
  notify(bss, task.boardId, 'board.task_moved', payload);
}

/**
 * board.task_assigned
 * Payload mirrors handlers/domains/board/assign-task.ts: taskId, taskTitle,
 * assignedAgentId, tags, columnId + actor.
 */
export function emitTaskAssigned(
  bss: BoardSubscriptionService,
  task: TaskLike,
  actor: BoardEventActor,
): void {
  const payload: BoardEventPayload = {
    taskId: task.taskId,
    taskTitle: task.title,
    assignedAgentId: task.assignedAgentId ?? undefined,
    tags: task.tags,
    columnId: task.columnId,
    ...actor,
  };
  notify(bss, task.boardId, 'board.task_assigned', payload);
}

/**
 * board.task_updated
 * Payload mirrors handlers/domains/board/update-task.ts: taskId, taskTitle,
 * assignedAgentId, tags, columnId + actor.
 */
export function emitTaskUpdated(
  bss: BoardSubscriptionService,
  task: TaskLike,
  actor: BoardEventActor,
): void {
  const payload: BoardEventPayload = {
    taskId: task.taskId,
    taskTitle: task.title,
    assignedAgentId: task.assignedAgentId ?? undefined,
    tags: task.tags,
    columnId: task.columnId,
    ...actor,
  };
  notify(bss, task.boardId, 'board.task_updated', payload);
}

/**
 * board.task_created
 * Payload mirrors handlers/domains/board/create-task.ts and
 * batch-create-tasks.ts: taskId, taskTitle, assignedAgentId, tags, columnId,
 * columnName + actor.
 */
export function emitTaskCreated(
  bss: BoardSubscriptionService,
  task: TaskLike,
  columnName: string | undefined,
  actor: BoardEventActor,
): void {
  const payload: BoardEventPayload = {
    taskId: task.taskId,
    taskTitle: task.title,
    assignedAgentId: task.assignedAgentId ?? undefined,
    tags: task.tags,
    columnId: task.columnId,
    columnName,
    ...actor,
  };
  notify(bss, task.boardId, 'board.task_created', payload);
}

/**
 * board.task_archived
 * Payload mirrors handlers/domains/board/archive-task.ts: taskId, taskTitle,
 * assignedAgentId, tags, columnId, archived + actor. The formatted message
 * produced by formatEventMessage is identical to the inline message the
 * domain handler builds.
 */
export function emitTaskArchived(
  bss: BoardSubscriptionService,
  task: TaskLike,
  archived: boolean,
  actor: BoardEventActor,
): void {
  const payload: BoardEventPayload = {
    taskId: task.taskId,
    taskTitle: task.title,
    assignedAgentId: task.assignedAgentId ?? undefined,
    tags: task.tags,
    columnId: task.columnId,
    archived,
    ...actor,
  };
  notify(bss, task.boardId, 'board.task_archived', payload);
}

/**
 * board.dependency_added
 * Payload mirrors handlers/domains/board/add-dependency.ts: taskId,
 * taskTitle, assignedAgentId, tags, columnId, dependsOnTaskId + actor.
 */
export function emitDependencyAdded(
  bss: BoardSubscriptionService,
  task: TaskLike,
  dependsOnTaskId: string,
  actor: BoardEventActor,
): void {
  const payload: BoardEventPayload = {
    taskId: task.taskId,
    taskTitle: task.title,
    assignedAgentId: task.assignedAgentId ?? undefined,
    tags: task.tags,
    columnId: task.columnId,
    dependsOnTaskId,
    ...actor,
  };
  notify(bss, task.boardId, 'board.dependency_added', payload);
}

/**
 * board.dependency_removed
 * Payload mirrors handlers/domains/board/remove-dependency.ts: taskId,
 * taskTitle, assignedAgentId, tags, columnId, dependsOnTaskId + actor.
 */
export function emitDependencyRemoved(
  bss: BoardSubscriptionService,
  task: TaskLike,
  dependsOnTaskId: string,
  actor: BoardEventActor,
): void {
  const payload: BoardEventPayload = {
    taskId: task.taskId,
    taskTitle: task.title,
    assignedAgentId: task.assignedAgentId ?? undefined,
    tags: task.tags,
    columnId: task.columnId,
    dependsOnTaskId,
    ...actor,
  };
  notify(bss, task.boardId, 'board.dependency_removed', payload);
}
