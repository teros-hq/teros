/**
 * BoardEventService
 *
 * Persists board activity events to the `board_events` collection and
 * maintains `board_daily_stats` incrementally.
 *
 * This replaces the old pattern of `$push`-ing TaskActivityEntry objects
 * into an embedded `activity` array on each Task document. With this service:
 *   - Events are their own documents (no unbounded array growth)
 *   - Events can be queried by board, project, workspace, task, actor, or type
 *   - Daily stats are maintained in real-time as events arrive
 *   - TTL can be applied for retention without affecting task documents
 *
 * Integration:
 *   BoardService calls `boardEventService.recordEvent(...)` instead of
 *   `$push: { activity: entry }`. The service handles both the event insert
 *   and the daily stats update in a single call.
 */

import { generateId } from '@teros/core';
import { COLLECTIONS, ensureCollectionIndexes } from '../db';
import type { Collection, Db, Filter } from 'mongodb';
import type {
  Board,
  BoardDailyStats,
  BoardEvent,
  BoardEventCategory,
  BoardEventDetails,
  Project,
} from '../types/database';

// ============================================================================
// TYPES
// ============================================================================

export interface RecordEventInput {
  boardId: string;
  projectId: string;
  workspaceId: string;
  taskId: string | null;
  taskTitle: string | null;
  eventType: BoardEventCategory;
  actor: string;
  timestamp?: string;
  details?: BoardEventDetails;
}

export interface EventQueryOptions {
  boardId?: string;
  projectId?: string;
  workspaceId?: string;
  taskId?: string;
  actor?: string;
  eventTypes?: BoardEventCategory[];
  /** Inclusive start (ISO 8601) */
  fromTimestamp?: string;
  /** Exclusive end (ISO 8601) */
  toTimestamp?: string;
  /** Max results (default 50, max 200) */
  limit?: number;
  /** Pagination cursor — timestamp of the last event from the previous page */
  cursor?: string;
  /** Sort order — default 'desc' (newest first) */
  sort?: 'asc' | 'desc';
}

export interface EventQueryResult {
  events: BoardEvent[];
  /** Cursor for the next page (timestamp of the last event in this page) */
  nextCursor?: string;
  hasMore: boolean;
}

// ============================================================================
// MAPPING: old TaskActivityEventType → new BoardEventCategory
// ============================================================================

/**
 * Maps legacy TaskActivityEventType values to the new BoardEventCategory.
 * Used during backfill migration and for backward-compatible reads.
 */
const ACTIVITY_TYPE_MAP: Record<string, BoardEventCategory> = {
  created: 'task.created',
  moved: 'task.moved',
  assigned: 'task.assigned',
  unassigned: 'task.unassigned',
  started: 'task.started',
  linked: 'task.linked',
  priority_changed: 'task.priority_changed',
  updated: 'task.updated',
  deleted: 'task.deleted',
  status_changed: 'task.moved', // status_changed was used for archive/restore; map to moved
  progress_note: 'task.progress_note',
  running_changed: 'task.running_changed',
  dependency_added: 'task.dependency_added',
  dependency_removed: 'task.dependency_removed',
  circular_dependency_detected: 'task.circular_dependency_detected',
};

/**
 * Maps a legacy TaskActivityEventType to the new BoardEventCategory.
 * Returns 'task.updated' as fallback for unknown types.
 */
export function mapActivityTypeToEventCategory(legacyType: string): BoardEventCategory {
  return ACTIVITY_TYPE_MAP[legacyType] ?? 'task.updated';
}

// ============================================================================
// SERVICE
// ============================================================================

/**
 * Public topic of a board event category. Internal categories are `task.<verb>`
 * (and a few `board.*` kept for subscription compatibility); on the event bus
 * every one of them lives under the `board.` namespace as `board.task_<verb>`
 * (`task.moved` → `board.task_moved`), so the catalog has one spelling.
 */
export function boardEventTopic(category: string): string {
  if (category.startsWith('board.')) return category;
  if (category.startsWith('task.')) return `board.task_${category.slice('task.'.length)}`;
  return `board.${category.replace(/\./g, '_')}`;
}

export class BoardEventService {
  private eventDispatcher?: (topic: string, payload: Record<string, unknown>) => Promise<void>;

  private events: Collection<BoardEvent>;
  private stats: Collection<BoardDailyStats>;

  /** Max events to keep in recentEventIds on daily stats */
  private readonly MAX_RECENT_EVENTS = 20;

  constructor(private db: Db) {
    this.events = db.collection<BoardEvent>('board_events');
    this.stats = db.collection<BoardDailyStats>('board_daily_stats');
  }

  // --------------------------------------------------------------------------
  // INITIALIZATION
  // --------------------------------------------------------------------------

  async ensureIndexes(): Promise<void> {
    // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry with
    // ensureAllIndexes after migrations. Kept for tests and scripts.
    // board_events has no TTL: evidence never expires (product decision 2026-09-23).
    await ensureCollectionIndexes(this.events, COLLECTIONS.boardEvents);
    await ensureCollectionIndexes(this.stats, COLLECTIONS.boardDailyStats);
  }

  // --------------------------------------------------------------------------
  // EVENT RECORDING
  // --------------------------------------------------------------------------

  /**
   * Record a board event and update daily stats.
   *
   * This is the primary entry point, called by BoardService after each
   * state mutation. It inserts the event document and incrementally
   * updates the daily stats for the event's board+date.
   *
   * Fire-and-forget semantics: the caller does not need to await this
   * for correctness of the task mutation, but awaiting ensures the event
   * is persisted before returning to the user.
   */
  async recordEvent(input: RecordEventInput): Promise<BoardEvent> {
    const timestamp = input.timestamp ?? new Date().toISOString();
    const date = timestamp.slice(0, 10); // YYYY-MM-DD in UTC

    const event: BoardEvent = {
      eventId: generateId('bevt'),
      boardId: input.boardId,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      taskTitle: input.taskTitle,
      eventType: input.eventType,
      actor: input.actor,
      timestamp,
      details: input.details,
    };

    await this.events.insertOne(event);

    // Update daily stats (non-fatal if this fails; awaited so the stats are
    // current when the caller returns — MOD-4)
    await this._updateDailyStats(event, date).catch((err) => {
      console.error('[BoardEventService] Error updating daily stats:', err);
    });

    // Publish on the event bus (non-fatal) under the public `board.*` topic.
    if (this.eventDispatcher) {
      const { details, ...rest } = event;
      this.eventDispatcher(boardEventTopic(event.eventType), {
        ...(details ?? {}),
        ...rest,
        occurredAt: timestamp,
      }).catch((err) => {
        console.error('[BoardEventService] Error dispatching event to the bus:', err);
      });
    }

    return event;
  }

  /** Bus publisher for `board.*` events (set at bootstrap). */
  setEventDispatcher(fn: (topic: string, payload: Record<string, unknown>) => Promise<void>): void {
    this.eventDispatcher = fn;
  }

  // --------------------------------------------------------------------------
  // EVENT QUERIES
  // --------------------------------------------------------------------------

  /**
   * Query board events with filtering, pagination, and sorting.
   */
  async queryEvents(options: EventQueryOptions): Promise<EventQueryResult> {
    const limit = Math.min(options.limit ?? 50, 200);
    const sort: 1 | -1 = options.sort === 'asc' ? 1 : -1;

    const filter: Filter<BoardEvent> = {};

    if (options.boardId) filter.boardId = options.boardId;
    if (options.projectId) filter.projectId = options.projectId;
    if (options.workspaceId) filter.workspaceId = options.workspaceId;
    if (options.taskId) filter.taskId = options.taskId;
    if (options.actor) filter.actor = options.actor;
    if (options.eventTypes && options.eventTypes.length > 0) {
      filter.eventType = { $in: options.eventTypes };
    }

    // Timestamp range + cursor pagination
    const tsFilter: Record<string, string> = {};
    if (options.fromTimestamp) tsFilter.$gte = options.fromTimestamp;
    if (options.toTimestamp) tsFilter.$lt = options.toTimestamp;
    if (options.cursor) {
      if (sort === -1) {
        // Descending: next page has timestamps < cursor
        tsFilter.$lt = options.cursor;
      } else {
        // Ascending: next page has timestamps > cursor
        tsFilter.$gt = options.cursor;
      }
    }
    if (Object.keys(tsFilter).length > 0) {
      (filter as Record<string, unknown>).timestamp = tsFilter;
    }

    const events = await this.events
      .find(filter)
      .sort({ timestamp: sort })
      .limit(limit + 1) // fetch one extra to check hasMore
      .toArray();

    const hasMore = events.length > limit;
    const results = hasMore ? events.slice(0, limit) : events;

    const nextCursor =
      results.length > 0 ? results[results.length - 1].timestamp : undefined;

    return {
      events: results,
      nextCursor: hasMore ? nextCursor : undefined,
      hasMore,
    };
  }

  /**
   * Get the activity feed for a specific task.
   * Convenience wrapper around queryEvents.
   */
  async getTaskActivity(taskId: string, limit = 50): Promise<BoardEvent[]> {
    const result = await this.queryEvents({ taskId, limit, sort: 'asc' });
    return result.events;
  }

  /**
   * Get the unified activity feed for a board.
   * Convenience wrapper around queryEvents.
   */
  async getBoardFeed(
    boardId: string,
    options?: Omit<EventQueryOptions, 'boardId'>,
  ): Promise<EventQueryResult> {
    return this.queryEvents({ ...options, boardId });
  }

  // --------------------------------------------------------------------------
  // DAILY STATS
  // --------------------------------------------------------------------------

  /**
   * Get daily stats for a board on a specific date.
   * Returns null if no stats exist for that date.
   */
  async getDailyStats(boardId: string, date: string): Promise<BoardDailyStats | null> {
    return this.stats.findOne({ boardId, date });
  }

  /**
   * Get daily stats for a board over a date range (inclusive).
   * Returns an array sorted by date ascending.
   */
  async getDailyStatsRange(
    boardId: string,
    fromDate: string,
    toDate: string,
  ): Promise<BoardDailyStats[]> {
    return this.stats
      .find({
        boardId,
        date: { $gte: fromDate, $lte: toDate },
      })
      .sort({ date: 1 })
      .toArray();
  }

  /**
   * Get daily stats for all boards in a workspace over a date range.
   * Useful for workspace-level dashboards.
   */
  async getWorkspaceDailyStats(
    workspaceId: string,
    fromDate: string,
    toDate: string,
  ): Promise<BoardDailyStats[]> {
    return this.stats
      .find({
        workspaceId,
        date: { $gte: fromDate, $lte: toDate },
      })
      .sort({ date: 1 })
      .toArray();
  }

  // --------------------------------------------------------------------------
  // INTERNAL: DAILY STATS UPDATE
  // --------------------------------------------------------------------------

  /**
   * Incrementally update the daily stats document for a given board+date.
   *
   * Uses upsert + $inc + $addToSet to atomically update counters.
   * Called after each event is inserted.
   */
  private async _updateDailyStats(event: BoardEvent, date: string): Promise<void> {
    const now = new Date().toISOString();

    // Build the $inc object based on event type
    const inc: Record<string, number> = {};
    const addToSet: Record<string, unknown> = {};

    switch (event.eventType) {
      case 'task.created':
      case 'board.task_created':
        inc.tasksCreated = 1;
        break;
      case 'task.moved':
      case 'board.task_moved':
        inc.tasksMoved = 1;
        // Check if it's a completion or block via details
        if (event.details?.toColumn === 'done' || event.details?.toColumnName?.toLowerCase() === 'done') {
          inc.tasksCompleted = 1;
        } else if (event.details?.toColumn === 'blocked' || event.details?.toColumnName?.toLowerCase() === 'blocked') {
          inc.tasksBlocked = 1;
        } else if (event.details?.toColumn === 'in_progress' || event.details?.toColumnName?.toLowerCase() === 'in progress') {
          inc.tasksStarted = 1;
        }
        break;
      case 'task.started':
        inc.tasksStarted = 1;
        break;
      case 'task.completed':
        inc.tasksCompleted = 1;
        break;
      case 'task.blocked':
        inc.tasksBlocked = 1;
        break;
      case 'task.archived':
      case 'board.task_archived':
        inc.tasksArchived = 1;
        break;
      case 'task.progress_note':
      case 'board.task_progress_note':
        inc.progressNotesPosted = 1;
        break;
      case 'task.assigned':
      case 'board.task_assigned':
        inc.assignmentsMade = 1;
        break;
      case 'task.unassigned':
        inc.unassignmentsMade = 1;
        break;
      case 'task.dependency_added':
      case 'board.dependency_added':
        inc.dependenciesAdded = 1;
        break;
      case 'task.dependency_removed':
      case 'board.dependency_removed':
        inc.dependenciesRemoved = 1;
        break;
      default:
        // Event types that don't affect stats counters (updated, linked, running_changed, etc.)
        break;
    }

    // Track active agents (any event with an agent actor)
    if (event.actor && event.actor !== 'system' && !event.actor.startsWith('system:')) {
      addToSet.activeAgents = event.actor;
    }

    // Build the update operation.
    //
    // MongoDB (7.0.40, verified empirically on RAW) rejects any update where
    // the same path appears in $setOnInsert AND in $inc/$addToSet/$push —
    // "Updating the path 'X' would create a conflict at 'X'" — even on the
    // INSERT path of the upsert. The previous code initialized every counter
    // to 0 in $setOnInsert and then $inc'd/$addToSet'd the same paths, so this
    // method failed for 100% of counter-carrying events since the service was
    // created (2026-08-14): board_daily_stats never received a single live
    // write (only the backfill docs exist). Rule: $setOnInsert carries
    // identity fields + defaults ONLY for paths this event does not mutate.
    // Mutated paths are created by their own operator on insert ($inc treats
    // a missing field as 0; $addToSet/$push create the array).
    const counterDefaults: Record<string, number> = {
      tasksCreated: 0,
      tasksMoved: 0,
      tasksCompleted: 0,
      tasksBlocked: 0,
      tasksArchived: 0,
      tasksStarted: 0,
      progressNotesPosted: 0,
      dependenciesAdded: 0,
      dependenciesRemoved: 0,
      assignmentsMade: 0,
      unassignmentsMade: 0,
    };

    const setOnInsert: Record<string, unknown> = {
      statsId: generateId('bds'),
      boardId: event.boardId,
      projectId: event.projectId,
      workspaceId: event.workspaceId,
      date,
      columnCounts: {},
      createdAt: now,
    };

    // Initialize untouched counters to 0 so documents keep the full schema;
    // skip any counter this event mutates (its operator creates it on insert).
    for (const field of Object.keys(counterDefaults)) {
      if (!(field in inc)) {
        setOnInsert[field] = counterDefaults[field];
      }
    }

    // Same rule for the agent array: skip if this event adds to it.
    if (!('activeAgents' in addToSet)) {
      setOnInsert.activeAgents = [];
    }

    const update: Record<string, unknown> = {
      $setOnInsert: setOnInsert,
      $set: { updatedAt: now },
      // recentEventIds is NEVER in $setOnInsert — $push always applies and
      // setOnInsert + push on the same path conflicts (see note above).
      $push: {
        recentEventIds: {
          $each: [event.eventId],
          $slice: -this.MAX_RECENT_EVENTS,
        },
      },
    };

    if (Object.keys(inc).length > 0) {
      update.$inc = inc;
    }

    if (Object.keys(addToSet).length > 0) {
      update.$addToSet = addToSet;
    }

    await this.stats.updateOne({ boardId: event.boardId, date }, update, { upsert: true });
  }

  // --------------------------------------------------------------------------
  // BACKFILL (called from migration)
  // --------------------------------------------------------------------------

  /**
   * Backfill board_events from existing Task.activity arrays.
   *
   * Called by the migration script. Reads all tasks that have activity entries,
   * converts each entry to a BoardEvent document, and inserts them in batches.
   *
   * Also populates board_daily_stats from the backfilled events.
   *
   * @param boards Map of boardId → Board (for projectId lookup)
   * @param projects Map of projectId → Project (for workspaceId lookup)
   * @param batchSize Number of events to insert per batch (default 500)
   * @returns Number of events backfilled
   */
  async backfillFromTaskActivity(
    boards: Map<string, Board>,
    projects: Map<string, Project>,
    batchSize = 500,
  ): Promise<number> {
    const tasksCol = this.db.collection('tasks');
    let totalEvents = 0;

    // Find all tasks with non-empty activity arrays
    const cursor = tasksCol.find(
      { activity: { $exists: true, $ne: [] } },
      { projection: { taskId: 1, boardId: 1, title: 1, activity: 1 } },
    );

    let batch: BoardEvent[] = [];

    for await (const task of cursor) {
      const board = boards.get(task.boardId);
      if (!board) continue;

      const project = projects.get(board.projectId);
      if (!project) continue;

      for (const entry of task.activity ?? []) {
        const event: BoardEvent = {
          eventId: generateId('bevt'),
          boardId: task.boardId,
          projectId: board.projectId,
          workspaceId: project.workspaceId,
          taskId: task.taskId,
          taskTitle: task.title,
          eventType: mapActivityTypeToEventCategory(entry.eventType),
          actor: entry.actor,
          timestamp: entry.timestamp,
          details: entry.details as BoardEventDetails | undefined,
        };

        batch.push(event);
        totalEvents++;

        if (batch.length >= batchSize) {
          await this.events.insertMany(batch);
          batch = [];
        }
      }
    }

    // Insert remaining
    if (batch.length > 0) {
      await this.events.insertMany(batch);
    }

    // Rebuild daily stats from backfilled events
    await this._rebuildDailyStatsFromEvents();

    console.log(`[BoardEventService] Backfilled ${totalEvents} events from task.activity arrays`);
    return totalEvents;
  }

  /**
   * Rebuild all board_daily_stats from the events collection.
   * Called after backfill to ensure stats are consistent.
   */
  private async _rebuildDailyStatsFromEvents(): Promise<void> {
    // Clear existing stats (they'll be rebuilt)
    await this.stats.deleteMany({});

    // Aggregate events by boardId + date
    const pipeline = [
      {
        $group: {
          _id: { boardId: '$boardId', date: { $substr: ['$timestamp', 0, 10] } },
          projectId: { $first: '$projectId' },
          workspaceId: { $first: '$workspaceId' },
          events: { $push: '$$ROOT' },
        },
      },
    ];

    const groups = await this.events.aggregate(pipeline).toArray();

    for (const group of groups) {
      const { boardId, date } = group._id;
      const events: BoardEvent[] = group.events;

      const stats: BoardDailyStats = {
        statsId: generateId('bds'),
        boardId,
        projectId: group.projectId,
        workspaceId: group.workspaceId,
        date,
        columnCounts: {},
        tasksCreated: events.filter((e) => e.eventType === 'task.created' || e.eventType === 'board.task_created').length,
        tasksMoved: events.filter((e) => e.eventType === 'task.moved' || e.eventType === 'board.task_moved').length,
        tasksCompleted: events.filter((e) =>
          e.eventType === 'task.completed' ||
          (e.eventType === 'task.moved' && (e.details?.toColumn === 'done' || e.details?.toColumnName?.toLowerCase() === 'done'))
        ).length,
        tasksBlocked: events.filter((e) =>
          e.eventType === 'task.blocked' ||
          (e.eventType === 'task.moved' && (e.details?.toColumn === 'blocked' || e.details?.toColumnName?.toLowerCase() === 'blocked'))
        ).length,
        tasksArchived: events.filter((e) => e.eventType === 'task.archived' || e.eventType === 'board.task_archived').length,
        tasksStarted: events.filter((e) => e.eventType === 'task.started').length,
        progressNotesPosted: events.filter((e) => e.eventType === 'task.progress_note' || e.eventType === 'board.task_progress_note').length,
        dependenciesAdded: events.filter((e) => e.eventType === 'task.dependency_added' || e.eventType === 'board.dependency_added').length,
        dependenciesRemoved: events.filter((e) => e.eventType === 'task.dependency_removed' || e.eventType === 'board.dependency_removed').length,
        activeAgents: [...new Set(events.filter((e) => e.actor && e.actor !== 'system' && !e.actor.startsWith('system:')).map((e) => e.actor))],
        assignmentsMade: events.filter((e) => e.eventType === 'task.assigned' || e.eventType === 'board.task_assigned').length,
        unassignmentsMade: events.filter((e) => e.eventType === 'task.unassigned').length,
        recentEventIds: events.slice(-this.MAX_RECENT_EVENTS).map((e) => e.eventId),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await this.stats.insertOne(stats);
    }

    console.log(`[BoardEventService] Rebuilt daily stats for ${groups.length} board-date combinations`);
  }
}
