/**
 * TodoSubscriptionService
 *
 * Manages to-do list event subscriptions: conversations (channels) that want
 * to receive real-time to-do events. A subscription links a conversation
 * (channelId) to a workspace's task tree, with an optional filter to narrow
 * which events are delivered.
 *
 * Parity with BoardSubscriptionService (the board's equivalent, see
 * docs/specs/todo/events.md for the board↔todo mapping):
 *   - board_subscriptions (boardId + channelId)  → todo_subscriptions
 *     (workspaceId + channelId — the workspace tree IS the scope; the to-do
 *     list has no board).
 *   - filter.taskIds      → filter.nodeIds   ("avísame cuando ESTA tarea acabe")
 *   - filter.agentIds     → filter.assigneeIds (agent or user ids)
 *   - filter.columnIds    → filter.states    (planning/pending/working/blocked/review/done — the NEW state)
 *   - (new)               → filter.groupNodeIds (scope to a group's subtree)
 *   - filter.eventTypes / wakeUpOn — same shape, todo.* values
 *
 * Delivery mirrors the board: notifySubscribers → eventInjector
 * (ScheduledEvent with wakeUpAgent) → event-handler, whose self-wake guard
 * (metadata.actorAgentId === channel.agentId) prevents an agent from being
 * woken by an event it produced itself.
 *
 * Migration note (same as the board's): the tactical path to the generic
 * SubscriptionService in packages/core is renaming workspaceId → mcaId +
 * filter.metadata.workspaceId and todo_subscriptions → mca_subscriptions.
 */

import { generateId } from '@teros/core';
import { COLLECTIONS, ensureCollectionIndexes } from '../db';
import type { Collection, Db } from 'mongodb';
import type { TodoSubscription, TodoSubscriptionFilter, TodoEventType } from '../types/database';
import type { ScheduledEvent } from '../handlers/event-handler';

// ============================================================================
// TODO EVENT PAYLOAD TYPES
// ============================================================================

/**
 * A to-do event — emitted by the todo actions / autoplay service after
 * mutating task state. The payload is self-contained: no additional DB
 * queries needed by subscribers (except group-scope matching, see
 * _passesFilter).
 */
export interface TodoEvent {
  eventType: TodoEventType;
  workspaceId: string;
  /** Human-readable formatted message for the subscribed agent */
  formattedMessage: string;
  /** Full event payload — treated as opaque except by _passesFilter */
  payload: TodoEventPayload;
}

export interface TodoEventPayload {
  nodeId?: string;
  /** The task's title (node text). */
  text?: string;
  /** The task's NEW state (after the mutation). */
  state?: string;
  /** The task's PREVIOUS state (state changes only). */
  fromState?: string;
  parentId?: string | null;
  /** Direct parent's text, when cheaply known (moves). */
  parentText?: string;
  /** 'agent' | 'user' — the task's assignee kind. */
  assigneeKind?: string;
  /** The task's assignee id (agentId or userId). */
  assigneeId?: string;
  /** 'agent' | 'user' — the task's reviewer kind (TODORV). */
  reviewerKind?: string;
  /** The task's reviewer id (agentId or userId) — set on review-relevant events. */
  reviewerId?: string;
  /** The task's linked conversation, when it has one. */
  channelId?: string | null;
  /**
   * Agent that caused this event, when the emitter was an agent. Consumed by
   * the self-wake guard in event-handler — an agent must not be woken by an
   * event it produced itself.
   */
  actorAgentId?: string;
  /** Human user that caused this event. */
  actorUserId?: string;
  /** blocked reason / planned day / progress / note / output context */
  reason?: string;
  day?: string | null;
  plannedTime?: string | null;
  progress?: number | null;
  noteText?: string;
  outputFormat?: string;
  outputName?: string;
  outputUrl?: string;
  /** move-node: previous parent / position. */
  fromParentId?: string | null;
  position?: number;
  /** autoplay runner context (agent_play_changed / agent_slots_changed). */
  agentId?: string;
  slots?: number;
  playEnabled?: boolean;
  /** TODODEP — the blocker a dependency event is about. */
  blockerNodeId?: string;
  blockerText?: string;
  blockerState?: string | null;
  [key: string]: unknown;
}

// ============================================================================
// CALLBACK TYPES
// ============================================================================

/** Inject a scheduled event into a channel (and optionally wake the agent) */
export type EventInjectorFn = (event: ScheduledEvent) => Promise<{ success: boolean; error?: string }>;

// ============================================================================
// DEFAULT WAKE-UP BEHAVIOUR
// ============================================================================

/**
 * Default wakeUpAgent value per event type when `wakeUpOn` is not configured.
 *
 * Same rule as the board (decision Pablo, 2026-09-24): EVERY event type wakes
 * by default. Silence by default hid activity from subscribed agents;
 * over-waking is monitored (🔕 self-wake guard logs in event-handler) and
 * tuned later, which is strictly preferable to missing events.
 */
const DEFAULT_WAKE_UP: Record<TodoEventType, boolean> = {
  'task_created': true,
  'task_started': true,
  'task_completed': true,
  'task_blocked': true,
  'task_state_changed': true,
  'task_assigned': true,
  'task_unassigned': true,
  'task_planned': true,
  'task_output_delivered': true,
  'task_progress': true,
  'task_updated': true,
  'task_moved': true,
  'task_deleted': true,
  'agent_play_changed': true,
  'agent_slots_changed': true,
  'global_play_changed': true,
  'dependency_added': true,
  'dependency_removed': true,
};

/** Max ancestor hops when resolving a node's group chain (cycle safety). */
const MAX_ANCESTOR_HOPS = 20;

// ============================================================================
// SERVICE
// ============================================================================

export class TodoSubscriptionService {
  private col: Collection<TodoSubscription>;
  private eventInjector?: EventInjectorFn;

  constructor(private db: Db) {
    this.col = db.collection<TodoSubscription>(COLLECTIONS.todoSubscriptions);
  }

  // --------------------------------------------------------------------------
  // INITIALIZATION
  // --------------------------------------------------------------------------

  async ensureIndexes(): Promise<void> {
    // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry
    // with ensureAllIndexes after migrations. Kept for tests and scripts.
    await ensureCollectionIndexes(this.col, COLLECTIONS.todoSubscriptions);
  }

  setEventInjector(fn: EventInjectorFn): void {
    this.eventInjector = fn;
  }

  /**
   * Inject an event into ONE channel directly (TODORV — the reviewer
   * notification). Same ScheduledEvent shape `_dispatch` builds, so delivery,
   * persistence and the self-wake guard behave identically to a subscription
   * delivery. Fire-and-forget contract: errors are logged, never thrown.
   */
  injectIntoChannel(
    channelId: string,
    message: string,
    payload: TodoEventPayload,
    eventType: TodoEventType,
  ): void {
    if (!this.eventInjector) {
      console.warn('[TodoSubscriptionService] No eventInjector set — skipping reviewer notification');
      return;
    }
    const scheduledEvent: ScheduledEvent = {
      channelId,
      message,
      eventType: 'task_update',
      wakeUpAgent: true,
      metadata: {
        source: 'todo_subscription',
        todoEventType: eventType,
        ...payload,
      } as any,
    };
    this.eventInjector(scheduledEvent).catch((err) => {
      console.error(`[TodoSubscriptionService] Reviewer notification failed for channel ${channelId}:`, err);
    });
  }

  // --------------------------------------------------------------------------
  // CRUD
  // --------------------------------------------------------------------------

  /**
   * Subscribe a channel to a workspace's to-do events (upsert — a second
   * subscribe for the same (workspaceId, channelId) REPLACES the filter of the
   * existing subscription in place, exactly like the board's upsert semantics
   * documented for fb_d211b16343bd3034).
   */
  async subscribe(
    workspaceId: string,
    channelId: string,
    agentId: string,
    filter: TodoSubscriptionFilter = {},
  ): Promise<TodoSubscription> {
    const now = new Date();

    const existing = await this.col.findOne({ workspaceId, channelId });
    if (existing) {
      const updated = await this.col.findOneAndUpdate(
        { workspaceId, channelId },
        { $set: { filter, agentId, updatedAt: now } },
        { returnDocument: 'after' },
      );
      console.log(`[TodoSubscriptionService] Updated subscription ${existing.subscriptionId} for channel ${channelId} in workspace ${workspaceId}`);
      return updated!;
    }

    const sub: TodoSubscription = {
      subscriptionId: generateId('tsub'),
      workspaceId,
      channelId,
      agentId,
      filter,
      createdAt: now,
      updatedAt: now,
    };
    await this.col.insertOne(sub);
    console.log(`[TodoSubscriptionService] Created subscription ${sub.subscriptionId} for channel ${channelId} in workspace ${workspaceId}`);
    return sub;
  }

  /** Like subscribe but reports created vs filter-replaced (fb_d211b16343bd3034 parity). */
  async subscribeWithStatus(
    workspaceId: string,
    channelId: string,
    agentId: string,
    filter: TodoSubscriptionFilter = {},
  ): Promise<{ subscription: TodoSubscription; created: boolean }> {
    const existing = await this.col.findOne({ workspaceId, channelId });
    const subscription = await this.subscribe(workspaceId, channelId, agentId, filter);
    return { subscription, created: !existing };
  }

  /** Cancel a channel's subscription for a workspace. True if deleted. */
  async unsubscribe(workspaceId: string, channelId: string): Promise<boolean> {
    const result = await this.col.deleteOne({ workspaceId, channelId });
    if (result.deletedCount > 0) {
      console.log(`[TodoSubscriptionService] Removed subscription for channel ${channelId} in workspace ${workspaceId}`);
    }
    return result.deletedCount > 0;
  }

  /** Cancel one subscription by id — only when it belongs to channelId. */
  async unsubscribeById(subscriptionId: string, channelId: string): Promise<boolean> {
    const result = await this.col.deleteOne({ subscriptionId, channelId });
    return result.deletedCount > 0;
  }

  /** List all subscriptions for a given channel. */
  async listByChannel(channelId: string): Promise<TodoSubscription[]> {
    return this.col.find({ channelId }).toArray();
  }

  /** Remove all subscriptions for a channel (e.g. when the channel is closed). */
  async cleanupChannel(channelId: string): Promise<number> {
    const result = await this.col.deleteMany({ channelId });
    if (result.deletedCount > 0) {
      console.log(`[TodoSubscriptionService] Cleaned up ${result.deletedCount} subscription(s) for closed channel ${channelId}`);
    }
    return result.deletedCount;
  }

  // --------------------------------------------------------------------------
  // EVENT DISPATCH
  // --------------------------------------------------------------------------

  /**
   * Notify all subscribers of a to-do event. Fire-and-forget — never blocks
   * and never propagates errors to the caller (same contract as the board).
   */
  notifySubscribers(workspaceId: string, event: TodoEvent): void {
    this._dispatch(workspaceId, event).catch((err) => {
      console.error(`[TodoSubscriptionService] Error dispatching event ${event.eventType} for workspace ${workspaceId}:`, err);
    });
  }

  private async _dispatch(workspaceId: string, event: TodoEvent): Promise<void> {
    if (!this.eventInjector) {
      console.warn('[TodoSubscriptionService] No eventInjector set — skipping dispatch');
      return;
    }

    const subs = await this.col.find({ workspaceId }).toArray();
    if (subs.length === 0) return;

    // Group-scope matching needs the node's ancestor chain; resolve it once
    // per dispatch, lazily, only when at least one candidate filter uses it.
    let ancestorIds: string[] | null = null;
    const needsAncestors = subs.some((s) => (s.filter.groupNodeIds ?? []).length > 0);
    if (needsAncestors && event.payload.nodeId) {
      ancestorIds = await this.resolveAncestorIds(workspaceId, event.payload.parentId ?? null);
    }

    const matching = subs.filter((sub) => this._passesFilter(sub.filter, event, ancestorIds ?? []));
    if (matching.length === 0) return;

    console.log(`[TodoSubscriptionService] Dispatching ${event.eventType} to ${matching.length} subscriber(s) in workspace ${workspaceId}`);

    await Promise.all(
      matching.map(async (sub) => {
        try {
          const wakeUpAgent = this._shouldWake(sub.filter, event.eventType);
          const scheduledEvent: ScheduledEvent = {
            channelId: sub.channelId,
            message: event.formattedMessage,
            eventType: 'task_update',
            wakeUpAgent,
            metadata: {
              source: 'todo_subscription',
              todoEventType: event.eventType,
              workspaceId: event.workspaceId,
              ...event.payload,
            } as any,
          };
          await this.eventInjector!(scheduledEvent);
        } catch (err) {
          console.error(`[TodoSubscriptionService] Error delivering to channel ${sub.channelId}:`, err);
        }
      }),
    );
  }

  /**
   * Walk a node's parent chain up to the root (bounded by MAX_ANCESTOR_HOPS
   * against cycles), returning the ancestor nodeIds outermost-last. Used only
   * for group-scope filter matching.
   */
  async resolveAncestorIds(workspaceId: string, parentId: string | null): Promise<string[]> {
    const chain: string[] = [];
    let current = parentId;
    for (let hop = 0; current && hop < MAX_ANCESTOR_HOPS; hop++) {
      chain.push(current);
      const node = await this.db
        .collection<{ nodeId: string; parentId: string | null }>(COLLECTIONS.todoNodes)
        .findOne({ workspaceId, nodeId: current }, { projection: { _id: 0, parentId: 1 } });
      if (!node) break;
      current = node.parentId ?? null;
    }
    return chain;
  }

  // --------------------------------------------------------------------------
  // FILTER EVALUATION (encapsulated here, board parity)
  // --------------------------------------------------------------------------

  /**
   * Returns true if the event passes the subscription filter.
   * Empty filter → always passes.
   *
   * Cross-event note: `states` matches the task's NEW state (payload.state);
   * `eventTypes` matches the granular topic (task_started, task_completed…).
   */
  private _passesFilter(filter: TodoSubscriptionFilter, event: TodoEvent, ancestorIds: string[]): boolean {
    const p = event.payload;

    // eventTypes filter
    if (filter.eventTypes && filter.eventTypes.length > 0) {
      if (!filter.eventTypes.includes(event.eventType)) return false;
    }

    // nodeIds filter — only events for these specific tasks
    if (filter.nodeIds && filter.nodeIds.length > 0) {
      if (!p.nodeId || !filter.nodeIds.includes(p.nodeId as string)) return false;
    }

    // assigneeIds filter — matches the task's assignee id
    if (filter.assigneeIds && filter.assigneeIds.length > 0) {
      if (!p.assigneeId || !filter.assigneeIds.includes(p.assigneeId as string)) return false;
    }

    // reviewerIds filter (TODORV) — matches the task's reviewer id
    if (filter.reviewerIds && filter.reviewerIds.length > 0) {
      if (!p.reviewerId || !filter.reviewerIds.includes(p.reviewerId as string)) return false;
    }

    // states filter — the task's NEW state
    if (filter.states && filter.states.length > 0) {
      if (!p.state || !filter.states.includes(p.state as string)) return false;
    }

    // groupNodeIds filter — the task is anywhere inside one of these groups'
    // subtrees (its parent chain contains one of the ids).
    if (filter.groupNodeIds && filter.groupNodeIds.length > 0) {
      if (!filter.groupNodeIds.some((g) => ancestorIds.includes(g))) return false;
    }

    return true;
  }

  /**
   * Determine whether this event should wake the subscribed agent.
   * Uses `wakeUpOn` from the filter if set; otherwise every event type wakes
   * (board decision 2026-09-24, applied verbatim).
   */
  private _shouldWake(filter: TodoSubscriptionFilter, eventType: TodoEventType): boolean {
    if (filter.wakeUpOn && filter.wakeUpOn.length > 0) {
      return filter.wakeUpOn.includes(eventType);
    }
    return DEFAULT_WAKE_UP[eventType] ?? true;
  }

  // --------------------------------------------------------------------------
  // MESSAGE FORMATTING
  // --------------------------------------------------------------------------

  /**
   * Generate a human-readable message for a to-do event. Called by
   * TodoEventService.publish before invoking notifySubscribers.
   */
  static formatEventMessage(event: Omit<TodoEvent, 'formattedMessage'>): string {
    const p = event.payload;
    const taskRef = p.text ? `"${p.text}"` : p.nodeId ?? 'unknown task';

    switch (event.eventType) {
      case 'task_created':
        return `✅ To-do event: task_created\nNew task ${taskRef}${p.parentText ? ` under "${p.parentText}"` : ''}${p.assigneeId ? `\nAssigned to: ${p.assigneeId}` : ''}`;

      case 'task_started':
        return `✅ To-do event: task_started\nTask ${taskRef} is now working${p.channelId ? `\nConversation: ${p.channelId}` : ''}${p.assigneeId ? `\nAssignee: ${p.assigneeId}` : ''}`;

      case 'task_completed':
        return `✅ To-do event: task_completed\nTask ${taskRef} reached "${p.state}"${p.reviewerId && p.state === 'review' ? `\nReviewer: ${p.reviewerKind} ${p.reviewerId}` : ''}${p.outputFormat ? `\nOutput: ${p.outputFormat}${p.outputName ? ` (${p.outputName})` : ''}` : ''}${p.outputUrl ? `\n${p.outputUrl}` : ''}`;

      case 'task_blocked':
        return `✅ To-do event: task_blocked\nTask ${taskRef} is blocked: ${p.reason ?? '(no reason)'}`;

      case 'task_state_changed':
        return `✅ To-do event: task_state_changed\nTask ${taskRef} moved from "${p.fromState}" to "${p.state}"`;

      case 'task_assigned':
        return `✅ To-do event: task_assigned\nTask ${taskRef} assigned to ${p.assigneeKind} ${p.assigneeId}`;

      case 'task_unassigned':
        return `✅ To-do event: task_unassigned\nTask ${taskRef} unassigned`;

      case 'task_planned':
        return p.day
          ? `✅ To-do event: task_planned\nTask ${taskRef} planned for ${p.day}${p.plannedTime ? ` at ${p.plannedTime}` : ''}`
          : `✅ To-do event: task_planned\nTask ${taskRef} taken off its day`;

      case 'task_output_delivered':
        return `✅ To-do event: task_output_delivered\nTask ${taskRef} delivered a ${p.outputFormat} output${p.outputUrl ? `\n${p.outputUrl}` : ''}`;

      case 'task_progress':
        return `✅ To-do event: task_progress\nTask ${taskRef}${p.progress !== undefined && p.progress !== null ? ` — ${p.progress}%` : ''}${p.noteText ? `\n${p.noteText}` : ''}`;

      case 'task_updated':
        return `✅ To-do event: task_updated\nTask ${taskRef} was updated`;

      case 'task_moved':
        return `✅ To-do event: task_moved\nTask ${taskRef} moved${p.parentText ? ` under "${p.parentText}"` : ' to the root'}`;

      case 'task_deleted':
        return `✅ To-do event: task_deleted\nTask ${taskRef} was deleted`;

      case 'agent_play_changed':
        return `✅ To-do event: agent_play_changed\nAgent ${p.agentId}: autoplay ${p.playEnabled ? 'enabled' : 'disabled'}`;

      case 'agent_slots_changed':
        return `✅ To-do event: agent_slots_changed\nAgent ${p.agentId}: slots set to ${p.slots}`;

      case 'dependency_added':
        return `✅ To-do event: dependency_added\nTask ${taskRef} now waits on "${p.blockerText ?? p.blockerNodeId}"${p.blockerState ? ` (${p.blockerState})` : ''}`;

      case 'dependency_removed':
        return `✅ To-do event: dependency_removed\nTask ${taskRef} no longer waits on "${p.blockerText ?? p.blockerNodeId}"`;

      default:
        return `✅ To-do event: ${event.eventType}\n${JSON.stringify(p)}`;
    }
  }
}
