/**
 * To-do event emitters — shared builders for todo subscription events
 * (mirror of services/board-event-emitters.ts for the to-do list).
 *
 * Every to-do mutation emits its events through THIS module so the payload
 * shape is identical no matter which path performed the mutation:
 *   1. the todo backend actions (mca-actions/todo.ts — the path every agent
 *      tool call takes);
 *   2. the autoplay service's own writes (todo-autoplay-service.ts: starts,
 *      re-wakes, zombie reaping, runner changes).
 *
 * Each emit does TWO things (board parity — see server-bootstrap: the board
 * publishes on the MCA event bus AND notifies board_subscriptions):
 *   1. `todoSubscriptions.notifySubscribers(...)` — wakes subscribed
 *      conversations (ScheduledEvent with wakeUpAgent + actorAgentId for the
 *      self-wake guard);
 *   2. `busDispatch({ topic: 'todo.<eventType>', payload })` — publishes on
 *      the MCA event bus, which feeds Automate event triggers, flows and
 *      generic channel subscriptions (`subscribe_to_events`).
 *
 * All emitters are fire-and-forget: they never throw to the caller and never
 * block the mutation that produced them.
 */

import { TodoSubscriptionService, type TodoEventPayload } from './todo-subscription-service';
import type { TodoEventType } from '../types/database';

/**
 * Who caused the event — exactly one of the two, mirroring the board.
 * `actorAgentId` is consumed by the self-wake guard in event-handler: an
 * agent must not be woken by an event it produced itself.
 */
export interface TodoEventActor {
  actorAgentId?: string;
  actorUserId?: string;
}

/**
 * Structural slice of a todo node the emitters need. Accepts any node
 * returned by the todo actions (TodoNode) or their summaries.
 */
export interface TodoNodeLike {
  nodeId: string;
  text: string;
  parentId: string | null;
  state?: string | null;
  assignee?: { kind: 'agent' | 'user'; id: string } | null;
  /** TODORV — who reviews the task when it enters `review`. */
  reviewer?: { kind: 'agent' | 'user'; id: string } | null;
  channelId?: string | null;
}

/** Callback that publishes an event on the MCA event bus (set at bootstrap). */
export type TodoBusDispatchFn = (
  event: { topic: string; payload: Record<string, unknown> },
) => Promise<unknown>;

/** Module-level bus publisher — injected from server-bootstrap (like the board's setEventDispatcher). */
let busDispatch: TodoBusDispatchFn | null = null;

/** Wire the bus publisher (called once at bootstrap; null disables bus publishing). */
export function setTodoBusDispatch(fn: TodoBusDispatchFn | null): void {
  busDispatch = fn;
}

/**
 * Public topic of a to-do event type: `task_started` → `todo.task_started`
 * (the `todo.` namespace on the MCA event bus, exactly as `board.` is for the
 * board — see boardEventTopic).
 */
export function todoEventTopic(eventType: string): string {
  return `todo.${eventType}`;
}

/**
 * Emit a to-do event: notify conversation subscribers + publish on the bus.
 * Fire-and-forget — errors are logged, never propagated.
 */
function emit(
  svc: TodoSubscriptionService,
  workspaceId: string,
  eventType: TodoEventType,
  payload: TodoEventPayload,
): void {
  const topic = todoEventTopic(eventType);

  // 1. Conversation subscriptions (wake mode, filters, self-wake guard).
  svc.notifySubscribers(workspaceId, {
    eventType,
    workspaceId,
    formattedMessage: TodoSubscriptionService.formatEventMessage({ eventType, workspaceId, payload }),
    payload,
  });

  // 2. MCA event bus (Automate triggers, flows, generic subscriptions).
  if (busDispatch) {
    try {
      const occurredAt = new Date().toISOString();
      busDispatch({ topic, payload: { ...payload, workspaceId, eventType: topic, occurredAt } })
        .then(() => undefined, (err: unknown) => {
          console.error(`[todo-event-emitters] bus dispatch failed for ${topic}:`, err);
        });
    } catch (err) {
      console.error(`[todo-event-emitters] bus dispatch threw for ${topic}:`, err);
    }
  }
}

/** Actor fields from a resolved LogActor ({ kind, id } → actorAgentId/actorUserId). */
export function actorFromLogActor(actor: { kind: 'user' | 'agent' | 'system'; id?: string }): TodoEventActor {
  if (actor.kind === 'agent' && actor.id) return { actorAgentId: actor.id };
  if (actor.kind === 'user' && actor.id) return { actorUserId: actor.id };
  return {};
}

/** Assignee fields of a node, spread-ready. */
function assigneeFields(node: TodoNodeLike): Pick<TodoEventPayload, 'assigneeKind' | 'assigneeId'> {
  return node.assignee
    ? { assigneeKind: node.assignee.kind, assigneeId: node.assignee.id }
    : {};
}

/** Reviewer fields of a node, spread-ready (TODORV). */
function reviewerFields(node: TodoNodeLike): Pick<TodoEventPayload, 'reviewerKind' | 'reviewerId'> {
  return node.reviewer
    ? { reviewerKind: node.reviewer.kind, reviewerId: node.reviewer.id }
    : {};
}

// ============================================================================
// TASK LIFECYCLE
// ============================================================================

/**
 * todo.task_created — a node was added (add-node).
 */
export function emitTaskCreated(
  svc: TodoSubscriptionService,
  wsId: string,
  node: TodoNodeLike,
  parentText: string | null,
  actor: TodoEventActor,
): void {
  emit(svc, wsId, 'task_created', {
    nodeId: node.nodeId,
    text: node.text,
    parentId: node.parentId,
    parentText: parentText ?? undefined,
    state: node.state ?? undefined,
    ...assigneeFields(node),
    ...actor,
  });
}

/**
 * todo.task_started — a task entered `working` (autoplay start, start-node,
 * or a manual set-state). Call once per start, with the post-transition node.
 */
export function emitTaskStarted(
  svc: TodoSubscriptionService,
  wsId: string,
  node: TodoNodeLike,
  fromState: string,
  actor: TodoEventActor,
): void {
  emit(svc, wsId, 'task_started', {
    nodeId: node.nodeId,
    text: node.text,
    parentId: node.parentId,
    state: 'working',
    fromState,
    channelId: node.channelId ?? null,
    ...assigneeFields(node),
    ...actor,
  });
}

/**
 * todo.task_completed — a task reached `done` or `review` ("work finished").
 * Fires for set-state, toggle-complete and autoplay completions, with the
 * output reference when one was delivered.
 */
export function emitTaskCompleted(
  svc: TodoSubscriptionService,
  wsId: string,
  node: TodoNodeLike,
  fromState: string,
  toState: 'done' | 'review',
  actor: TodoEventActor,
  output?: { format: string; name?: string; url?: string } | null,
): void {
  emit(svc, wsId, 'task_completed', {
    nodeId: node.nodeId,
    text: node.text,
    parentId: node.parentId,
    state: toState,
    fromState,
    channelId: node.channelId ?? null,
    outputFormat: output?.format,
    outputName: output?.name,
    outputUrl: output?.url,
    ...assigneeFields(node),
    ...reviewerFields(node),
    ...actor,
  });
}

/**
 * todo.task_blocked — a task entered `blocked` (set-state with reason).
 */
export function emitTaskBlocked(
  svc: TodoSubscriptionService,
  wsId: string,
  node: TodoNodeLike,
  fromState: string,
  reason: string,
  actor: TodoEventActor,
): void {
  emit(svc, wsId, 'task_blocked', {
    nodeId: node.nodeId,
    text: node.text,
    parentId: node.parentId,
    state: 'blocked',
    fromState,
    reason,
    channelId: node.channelId ?? null,
    ...assigneeFields(node),
    ...actor,
  });
}

/**
 * todo.task_state_changed — any state transition that is not one of the
 * granular events above (started/completed/blocked have their own emitters).
 */
export function emitTaskStateChanged(
  svc: TodoSubscriptionService,
  wsId: string,
  node: TodoNodeLike,
  fromState: string,
  toState: string,
  actor: TodoEventActor,
  extra: TodoEventPayload = {},
): void {
  emit(svc, wsId, 'task_state_changed', {
    nodeId: node.nodeId,
    text: node.text,
    parentId: node.parentId,
    state: toState,
    fromState,
    channelId: node.channelId ?? null,
    ...assigneeFields(node),
    ...actor,
    ...extra,
  });
}

// ============================================================================
// ASSIGNMENT / PLANNING / PROGRESS / OUTPUT
// ============================================================================

/**
 * todo.task_assigned — assign-node set an assignee.
 */
export function emitTaskAssigned(
  svc: TodoSubscriptionService,
  wsId: string,
  node: TodoNodeLike,
  actor: TodoEventActor,
): void {
  emit(svc, wsId, 'task_assigned', {
    nodeId: node.nodeId,
    text: node.text,
    parentId: node.parentId,
    state: node.state ?? undefined,
    ...assigneeFields(node),
    ...actor,
  });
}

/**
 * todo.task_unassigned — assign-node cleared the assignee.
 */
export function emitTaskUnassigned(
  svc: TodoSubscriptionService,
  wsId: string,
  node: TodoNodeLike,
  previousAssigneeId: string,
  actor: TodoEventActor,
): void {
  emit(svc, wsId, 'task_unassigned', {
    nodeId: node.nodeId,
    text: node.text,
    parentId: node.parentId,
    state: node.state ?? undefined,
    assigneeId: previousAssigneeId,
    ...actor,
  });
}

/**
 * todo.task_planned — plan-node set/changed/cleared the planned day or time.
 */
export function emitTaskPlanned(
  svc: TodoSubscriptionService,
  wsId: string,
  node: TodoNodeLike,
  day: string | null,
  plannedTime: string | null,
  actor: TodoEventActor,
): void {
  emit(svc, wsId, 'task_planned', {
    nodeId: node.nodeId,
    text: node.text,
    parentId: node.parentId,
    state: node.state ?? undefined,
    day,
    plannedTime,
    ...assigneeFields(node),
    ...actor,
  });
}

/**
 * todo.task_output_delivered — set-output stored an output.
 */
export function emitTaskOutputDelivered(
  svc: TodoSubscriptionService,
  wsId: string,
  node: TodoNodeLike,
  output: { format: string; name?: string; url?: string },
  actor: TodoEventActor,
): void {
  emit(svc, wsId, 'task_output_delivered', {
    nodeId: node.nodeId,
    text: node.text,
    parentId: node.parentId,
    state: node.state ?? undefined,
    outputFormat: output.format,
    outputName: output.name,
    outputUrl: output.url,
    ...assigneeFields(node),
    ...actor,
  });
}

/**
 * todo.task_progress — set-progress reported a percentage (or cleared it) and
 * add-log-entry appended a log note.
 */
export function emitTaskProgress(
  svc: TodoSubscriptionService,
  wsId: string,
  node: TodoNodeLike,
  progress: number | null,
  noteText: string | undefined,
  actor: TodoEventActor,
): void {
  emit(svc, wsId, 'task_progress', {
    nodeId: node.nodeId,
    text: node.text,
    parentId: node.parentId,
    state: node.state ?? undefined,
    progress,
    noteText,
    ...assigneeFields(node),
    ...actor,
  });
}

// ============================================================================
// STRUCTURE
// ============================================================================

/**
 * todo.task_updated — update-node changed text/description/instructions/
 * expectedOutput.
 */
export function emitTaskUpdated(
  svc: TodoSubscriptionService,
  wsId: string,
  node: TodoNodeLike,
  actor: TodoEventActor,
  fields?: string[],
): void {
  emit(svc, wsId, 'task_updated', {
    nodeId: node.nodeId,
    text: node.text,
    parentId: node.parentId,
    state: node.state ?? undefined,
    ...(fields ? { fields } : {}),
    ...assigneeFields(node),
    ...actor,
  });
}

/**
 * todo.task_moved — move-node changed the node's parent/position (the tree
 * equivalent of the board's column move).
 */
export function emitTaskMoved(
  svc: TodoSubscriptionService,
  wsId: string,
  node: TodoNodeLike,
  fromParentId: string | null,
  newParentText: string | null,
  position: number,
  actor: TodoEventActor,
): void {
  emit(svc, wsId, 'task_moved', {
    nodeId: node.nodeId,
    text: node.text,
    parentId: node.parentId,
    fromParentId,
    parentText: newParentText ?? undefined,
    position,
    state: node.state ?? undefined,
    ...assigneeFields(node),
    ...actor,
  });
}

/**
 * todo.task_deleted — delete-node removed a node (and its subtree).
 */
export function emitTaskDeleted(
  svc: TodoSubscriptionService,
  wsId: string,
  node: TodoNodeLike,
  descendantCount: number,
  actor: TodoEventActor,
): void {
  emit(svc, wsId, 'task_deleted', {
    nodeId: node.nodeId,
    text: node.text,
    parentId: node.parentId,
    state: node.state ?? undefined,
    descendantCount,
    ...actor,
  });
}

// ============================================================================
// DEPENDENCIES (TODODEP — Option A "ver y respetar", Pablo 2-nov)
// ============================================================================

/** The dependency the event is about: the blocker node's id, title and state. */
export interface TodoDependencyRef {
  nodeId: string;
  text: string;
  state: string | null;
}

/**
 * todo.dependency_added — a task now waits on another task (add-dependency;
 * the day/tree rows show the waiting semáforo). Board parity with the
 * dependency-added notification of the board's task_updated events.
 */
export function emitTaskDependencyAdded(
  svc: TodoSubscriptionService,
  wsId: string,
  node: TodoNodeLike,
  dependency: TodoDependencyRef,
  actor: TodoEventActor,
): void {
  emit(svc, wsId, 'dependency_added', {
    nodeId: node.nodeId,
    text: node.text,
    parentId: node.parentId,
    state: node.state ?? undefined,
    blockerNodeId: dependency.nodeId,
    blockerText: dependency.text,
    blockerState: dependency.state ?? undefined,
    ...assigneeFields(node),
    ...actor,
  });
}

/**
 * todo.dependency_removed — a task stopped waiting on another task
 * (remove-dependency; delete's purge emits nothing — the task is gone).
 */
export function emitTaskDependencyRemoved(
  svc: TodoSubscriptionService,
  wsId: string,
  node: TodoNodeLike,
  dependency: TodoDependencyRef,
  actor: TodoEventActor,
): void {
  emit(svc, wsId, 'dependency_removed', {
    nodeId: node.nodeId,
    text: node.text,
    parentId: node.parentId,
    state: node.state ?? undefined,
    blockerNodeId: dependency.nodeId,
    blockerText: dependency.text,
    blockerState: dependency.state ?? undefined,
    ...assigneeFields(node),
    ...actor,
  });
}

// ============================================================================
// AUTOPLAY RUNNERS
// ============================================================================

/**
 * todo.agent_slots_changed — set-agent-slots changed a runner's slots.
 */
export function emitAgentSlotsChanged(
  svc: TodoSubscriptionService,
  wsId: string,
  agentId: string,
  slots: number,
  actor: TodoEventActor,
): void {
  emit(svc, wsId, 'agent_slots_changed', { agentId, slots, ...actor });
}

/**
 * todo.agent_play_changed — set-agent-play toggled a runner's autoplay.
 */
export function emitAgentPlayChanged(
  svc: TodoSubscriptionService,
  wsId: string,
  agentId: string,
  playEnabled: boolean,
  actor: TodoEventActor,
): void {
  emit(svc, wsId, 'agent_play_changed', { agentId, playEnabled, ...actor });
}

/**
 * todo.global_play_changed — set-global-play toggled the workspace's autoplay
 * (the panel's global Play/Pause, TODOAP-REQ-30). `playing` is the new state;
 * a runner only works iff playing ∧ runner=playEnabled ∧ slots≥1.
 */
export function emitGlobalPlayChanged(
  svc: TodoSubscriptionService,
  wsId: string,
  playing: boolean,
  actor: TodoEventActor,
): void {
  emit(svc, wsId, 'global_play_changed', { playing, ...actor });
}
