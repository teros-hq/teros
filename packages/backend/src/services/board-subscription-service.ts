/**
 * BoardSubscriptionService
 *
 * Manages board event subscriptions: channels that want to receive real-time
 * board events. A subscription links a conversation (channelId) to a board,
 * with an optional filter to narrow which events are delivered.
 *
 * ─── Migration note ────────────────────────────────────────────────────────
 * This is a tactical implementation (Fase 3). The migration path to the
 * generic SubscriptionService in packages/core is:
 *   - `boardId` param → `mcaId` + `filter.metadata.boardId`
 *   - `board_subscriptions` collection → `mca_subscriptions`
 *   - `notifySubscribers(boardId, event)` → `notifySubscribers(mcaId, event)`
 *
 * ───────────────────────────────────────────────────────────────────────────
 */

import { generateId } from '@teros/core';
import type { Collection, Db } from 'mongodb';
import type { BoardEventType, BoardSubscription, BoardSubscriptionFilter } from '../types/database';
import type { ScheduledEvent } from '../handlers/event-handler';

// ============================================================================
// BOARD EVENT PAYLOAD TYPES
// ============================================================================

/**
 * A board event — emitted by handlers after mutating board state.
 * The payload is self-contained: no additional DB queries needed by subscribers.
 *
 * NOTE: Keep payload opaque in this service (rule 4 of spec §8 principles).
 * Field-level inspection only happens in `_passesFilter` for filter evaluation.
 */
export interface BoardEvent {
  eventType: BoardEventType;
  boardId: string;
  /** Human-readable formatted message for the subscribed agent */
  formattedMessage: string;
  /** Full event payload — treated as opaque by the service */
  payload: BoardEventPayload;
}

export interface BoardEventPayload {
  taskId?: string;
  taskTitle?: string;
  assignedAgentId?: string;
  columnId?: string;
  columnName?: string;
  fromColumnId?: string;
  fromColumnName?: string;
  toColumnId?: string;
  toColumnName?: string;
  tags?: string[];
  previousStatus?: string;
  newStatus?: string;
  agentId?: string;
  agentName?: string;
  slots?: number;
  playEnabled?: boolean;
  dependsOnTaskId?: string;
  noteText?: string;
  [key: string]: unknown;
}

// ============================================================================
// CALLBACK TYPES
// ============================================================================

/** Inject a scheduled event into a channel (and optionally wake the agent) */
export type EventInjectorFn = (event: ScheduledEvent) => Promise<{ success: boolean; error?: string }>;

// ============================================================================
// DEFAULT WAKE-UP BEHAVIOUR PER EVENT TYPE
// ============================================================================

/**
 * Default wakeUpAgent value per event type when `wakeUpOn` is not configured.
 * Rule: informational events don't wake; progress notes wake by default.
 */
const DEFAULT_WAKE_UP: Record<BoardEventType, boolean> = {
  'board.task_moved': false,
  'board.task_archived': false,
  'board.task_assigned': false,
  'board.task_created': false,
  'board.task_updated': false,
  'board.task_progress_note': true,
  'board.agent_play_changed': false,
  'board.agent_slots_changed': false,
  'board.dependency_added': false,
  'board.dependency_removed': false,
};

// ============================================================================
// SERVICE
// ============================================================================

export class BoardSubscriptionService {
  private col: Collection<BoardSubscription>;
  private eventInjector?: EventInjectorFn;

  constructor(private db: Db) {
    this.col = db.collection<BoardSubscription>('board_subscriptions');
  }

  // --------------------------------------------------------------------------
  // INITIALIZATION
  // --------------------------------------------------------------------------

  async ensureIndexes(): Promise<void> {
    await this.col.createIndex({ boardId: 1 }, { name: 'boardId_lookup' });
    await this.col.createIndex({ channelId: 1 }, { name: 'channelId_lookup' });
    await this.col.createIndex(
      { boardId: 1, channelId: 1 },
      { unique: true, name: 'boardId_channelId_unique' },
    );
    console.log('[BoardSubscriptionService] Indexes ensured for board_subscriptions');
  }

  setEventInjector(fn: EventInjectorFn): void {
    this.eventInjector = fn;
  }

  // --------------------------------------------------------------------------
  // CRUD
  // --------------------------------------------------------------------------

  /**
   * Subscribe a channel to board events (upsert — updates filter if already exists).
   * Migration: rename `boardId` param to `mcaId` when generalising.
   */
  async subscribe(
    boardId: string,
    channelId: string,
    agentId: string,
    filter: BoardSubscriptionFilter = {},
  ): Promise<BoardSubscription> {
    const now = new Date();

    const existing = await this.col.findOne({ boardId, channelId });
    if (existing) {
      // Update filter
      const updated = await this.col.findOneAndUpdate(
        { boardId, channelId },
        { $set: { filter, agentId, updatedAt: now } },
        { returnDocument: 'after' },
      );
      console.log(`[BoardSubscriptionService] Updated subscription ${existing.subscriptionId} for channel ${channelId} on board ${boardId}`);
      return updated!;
    }

    const sub: BoardSubscription = {
      subscriptionId: generateId('bsub'),
      boardId,
      channelId,
      agentId,
      filter,
      createdAt: now,
      updatedAt: now,
    };
    await this.col.insertOne(sub);
    console.log(`[BoardSubscriptionService] Created subscription ${sub.subscriptionId} for channel ${channelId} on board ${boardId}`);
    return sub;
  }

  /**
   * Cancel a subscription.
   * Returns true if deleted, false if not found.
   */
  async unsubscribe(boardId: string, channelId: string): Promise<boolean> {
    const result = await this.col.deleteOne({ boardId, channelId });
    if (result.deletedCount > 0) {
      console.log(`[BoardSubscriptionService] Removed subscription for channel ${channelId} on board ${boardId}`);
    }
    return result.deletedCount > 0;
  }

  /**
   * List all subscriptions for a given channel.
   */
  async listByChannel(channelId: string): Promise<BoardSubscription[]> {
    return this.col.find({ channelId }).toArray();
  }

  /**
   * Remove all subscriptions for a channel (e.g. when channel is closed).
   */
  async cleanupChannel(channelId: string): Promise<number> {
    const result = await this.col.deleteMany({ channelId });
    if (result.deletedCount > 0) {
      console.log(`[BoardSubscriptionService] Cleaned up ${result.deletedCount} subscription(s) for closed channel ${channelId}`);
    }
    return result.deletedCount;
  }

  // --------------------------------------------------------------------------
  // EVENT DISPATCH
  // --------------------------------------------------------------------------

  /**
   * Notify all subscribers of a board event.
   * Fire-and-forget — does not block the caller.
   *
   * Design rules followed (spec §8 principles):
   *   1. Filtering is encapsulated here, not in handlers.
   *   2. Payload is self-contained (formattedMessage included).
   *   3. Event names follow {context}.{artifact}_{action} scheme.
   *   4. Payload treated as opaque — only filter-relevant fields inspected.
   *   5. Interface is easily generalised: replace boardId with mcaId.
   */
  notifySubscribers(boardId: string, event: BoardEvent): void {
    // Fire-and-forget — errors are logged but never propagate to the caller
    this._dispatch(boardId, event).catch((err) => {
      console.error(`[BoardSubscriptionService] Error dispatching event ${event.eventType} for board ${boardId}:`, err);
    });
  }

  private async _dispatch(boardId: string, event: BoardEvent): Promise<void> {
    if (!this.eventInjector) {
      console.warn('[BoardSubscriptionService] No eventInjector set — skipping dispatch');
      return;
    }

    const subs = await this.col.find({ boardId }).toArray();
    if (subs.length === 0) return;

    const matching = subs.filter((sub) => this._passesFilter(sub.filter, event));
    if (matching.length === 0) return;

    console.log(`[BoardSubscriptionService] Dispatching ${event.eventType} to ${matching.length} subscriber(s) on board ${boardId}`);

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
              source: 'board_subscription',
              boardEventType: event.eventType,
              boardId: event.boardId,
              ...event.payload,
            } as any,
          };
          await this.eventInjector!(scheduledEvent);
        } catch (err) {
          console.error(`[BoardSubscriptionService] Error delivering to channel ${sub.channelId}:`, err);
        }
      }),
    );
  }

  // --------------------------------------------------------------------------
  // FILTER EVALUATION (encapsulated here per rule 1 of spec §8)
  // --------------------------------------------------------------------------

  /**
   * Returns true if the event passes the subscription filter.
   * Empty filter → always passes.
   */
  private _passesFilter(filter: BoardSubscriptionFilter, event: BoardEvent): boolean {
    const p = event.payload;

    // eventTypes filter
    if (filter.eventTypes && filter.eventTypes.length > 0) {
      if (!filter.eventTypes.includes(event.eventType)) return false;
    }

    // agentIds filter — matches assignedAgentId in the task payload
    if (filter.agentIds && filter.agentIds.length > 0) {
      if (!p.assignedAgentId || !filter.agentIds.includes(p.assignedAgentId as string)) return false;
    }

    // columnIds filter — matches current columnId OR destination column for moves
    if (filter.columnIds && filter.columnIds.length > 0) {
      const relevantColumn = (p.toColumnId as string | undefined) || (p.columnId as string | undefined);
      if (!relevantColumn || !filter.columnIds.includes(relevantColumn)) return false;
    }

    // tags filter — task must have ALL specified tags
    if (filter.tags && filter.tags.length > 0) {
      const taskTags = (p.tags as string[] | undefined) ?? [];
      if (!filter.tags.every((t) => taskTags.includes(t))) return false;
    }

    return true;
  }

  /**
   * Determine whether this event should wake the subscribed agent.
   * Uses `wakeUpOn` from the filter if set, otherwise falls back to defaults.
   */
  private _shouldWake(filter: BoardSubscriptionFilter, eventType: BoardEventType): boolean {
    if (filter.wakeUpOn && filter.wakeUpOn.length > 0) {
      return filter.wakeUpOn.includes(eventType);
    }
    return DEFAULT_WAKE_UP[eventType] ?? false;
  }

  // --------------------------------------------------------------------------
  // MESSAGE FORMATTING
  // --------------------------------------------------------------------------

  /**
   * Generate a human-readable message for a board event.
   * Called by handlers before invoking notifySubscribers.
   */
  static formatEventMessage(event: Omit<BoardEvent, 'formattedMessage'>): string {
    const p = event.payload;
    const taskRef = p.taskTitle ? `"${p.taskTitle}"` : p.taskId ?? 'unknown task';

    switch (event.eventType) {
      case 'board.task_moved':
        return `📋 Board event: task_moved\nTask ${taskRef} moved from "${p.fromColumnName ?? p.fromColumnId}" to "${p.toColumnName ?? p.toColumnId}"${p.assignedAgentId ? `\nAssigned to: ${p.assignedAgentId}` : ''}${p.tags && (p.tags as string[]).length > 0 ? `\nTags: ${(p.tags as string[]).map((t) => `#${t}`).join(' ')}` : ''}`;

      case 'board.task_archived':
        return `📋 Board event: task_archived\nTask ${taskRef}: ${p.archived ? 'archived' : 'unarchived'}`;

      case 'board.task_assigned':
        return p.assignedAgentId
          ? `📋 Board event: task_assigned\nTask ${taskRef} assigned to agent ${p.assignedAgentId}`
          : `📋 Board event: task_assigned\nTask ${taskRef} unassigned`;

      case 'board.task_created':
        return `📋 Board event: task_created\nNew task ${taskRef} created${p.columnName ? ` in "${p.columnName}"` : ''}${p.assignedAgentId ? `\nAssigned to: ${p.assignedAgentId}` : ''}`;

      case 'board.task_updated':
        return `📋 Board event: task_updated\nTask ${taskRef} was updated`;

      case 'board.task_progress_note':
        return `📋 Board event: task_progress_note\nTask ${taskRef}\nNote: ${p.noteText ?? '(no text)'}`;

      case 'board.agent_play_changed':
        return `📋 Board event: agent_play_changed\nAgent ${p.agentId ?? p.agentName}: autoplay ${p.playEnabled ? 'enabled' : 'disabled'}`;

      case 'board.agent_slots_changed':
        return `📋 Board event: agent_slots_changed\nAgent ${p.agentId ?? p.agentName}: slots set to ${p.slots}`;

      case 'board.dependency_added':
        return `📋 Board event: dependency_added\nTask ${taskRef} now depends on task ${p.dependsOnTaskId}`;

      case 'board.dependency_removed':
        return `📋 Board event: dependency_removed\nTask ${taskRef} no longer depends on task ${p.dependsOnTaskId}`;

      default:
        return `📋 Board event: ${event.eventType}\n${JSON.stringify(p)}`;
    }
  }
}
