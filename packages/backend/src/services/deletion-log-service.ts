/**
 * Deletion Log Service
 *
 * Provides `logDeletion(...)` — the single entry point that every delete
 * operation in the platform must call to leave a permanent trace.
 *
 * ## Transactional semantics
 *
 * The ideal is: the log entry and the delete are atomic — either both
 * succeed or neither does. MongoDB supports this via transactions with a
 * shared `ClientSession`. However, the Teros backend does not currently use
 * MongoDB transactions anywhere in the codebase (no `ClientSession` or
 * `withTransaction` usage exists), and introducing them here would require
 * replica-set configuration changes and broader coordination.
 *
 * **Decision taken:** log-first, then delete. The log entry is written
 * *before* the delete operation. This means:
 *
 * - If the log write fails → the delete is NOT performed. No data is lost
 *   silently. The caller receives the error and can retry or abort.
 * - If the log write succeeds but the delete fails → an orphaned log entry
 *   exists (it records a deletion that didn't happen). This is the lesser
 *   evil: a false-positive log entry can be reconciled by comparing with
 *   the source collection, but a silent deletion can never be recovered.
 *   The service logs a warning and re-throws the delete error so the caller
 *   knows the delete failed.
 * - If both succeed → correct state: the data is gone and the log explains why.
 *
 * When MongoDB transactions are available in the future, callers can pass
 * a `ClientSession` and the service will use it for both operations, making
 * them truly atomic.
 *
 * ## Usage
 *
 * ```typescript
 * import { getDeletionLogService } from '../services/deletion-log-service';
 *
 * // --- Single document delete by id ---
 * const svc = getDeletionLogService();
 * if (!svc) throw new Error('DeletionLogService not initialized');
 *
 * const result = await svc.logDeletion({
 *   collection: 'channels',
 *   docIds: ['ch_abc123'],
 *   reason: 'channel_close',
 *   actor: 'user_xyz',
 *   trigger: 'channel.close',
 *   deleteFn: async () => {
 *     return db.collection('channels').deleteOne({ channelId: 'ch_abc123' });
 *   },
 * });
 * // result.count === 1 (from the deleteOne result)
 *
 * // --- Bulk delete by filter ---
 * const result2 = await svc.logDeletion({
 *   collection: 'mca_event_subscriptions',
 *   filterSummary: 'expireAt <= now, mcaId=github',
 *   reason: 'subscription_cleanup',
 *   actor: 'system:ttl-sweeper',
 *   trigger: 'subscription.expiry',
 *   deleteFn: async () => {
 *     return db.collection('mca_event_subscriptions').deleteMany({
 *       expireAt: { $lte: new Date() },
 *       mcaId: 'mca.teros.github',
 *     });
 *   },
 * });
 * // result2.count === 47 (from the deleteMany result)
 * // result2.docIds may be truncated to MAX_DOC_IDS_STORED
 * ```
 *
 * If you already know the docIds and count (e.g. you fetched them before
 * deleting), pass them explicitly to avoid a second query:
 *
 * ```typescript
 * await svc.logDeletion({
 *   collection: 'apps',
 *   docIds: ['app_1', 'app_2', 'app_3'],
 *   count: 3,
 *   reason: 'app_uninstall',
 *   actor: 'user_xyz',
 *   trigger: 'app.uninstall',
 *   metadata: { workspaceId: 'work_abc' },
 * });
 * // No deleteFn — just logs the deletion that already happened
 * ```
 */

// @todo alice - 2026.09.24 : wire logDeletion into real delete paths (channel close, app uninstall,
// expiry sweeper) — service + model + migration landed, but no production caller invokes it yet

import { randomUUID } from 'crypto';
import type { ClientSession, Collection, Db, DeleteResult } from 'mongodb';
import {
  type DeletionLogEntry,
  type DeletionReason,
  MAX_DOC_IDS_STORED,
  getDeletionLogCollection,
} from '../models/deletion-log';
import { createLogger } from '../lib/logger';

const log = createLogger('DeletionLog');

// ============================================================================
// TYPES
// ============================================================================

/**
 * Parameters for `logDeletion`.
 *
 * Either provide `deleteFn` (and the service will call it after logging) or
 * provide `count` / `docIds` directly (for cases where the delete already
 * happened and you just need to record it).
 */
export interface LogDeletionParams {
  /** Name of the MongoDB collection from which documents were/will be deleted */
  collection: string;

  /**
   * Array of document ids that were/will be deleted. If omitted and `deleteFn`
   * is provided, the service will attempt to capture ids from the delete result
   * (not always possible — see `filterSummary`). Truncated to MAX_DOC_IDS_STORED.
   */
  docIds?: string[];

  /**
   * Human-readable summary of the filter used for a bulk delete.
   * E.g. `"expireAt <= now, mcaId=github"`. Avoids storing raw filter objects
   * which may contain sensitive values.
   */
  filterSummary?: string;

  /**
   * Total number of documents deleted. If omitted and `deleteFn` is provided,
   * the service will use `deleteResult.deletedCount`. If omitted and no
   * `deleteFn`, defaults to `docIds.length` (or 0 if no docIds).
   */
  count?: number;

  /** Why the deletion happened */
  reason: DeletionReason;

  /**
   * Who or what caused the deletion. For human actions: the userId.
   * For automated jobs: `system:<job-name>` (e.g. `system:ttl-sweeper`).
   */
  actor: string;

  /** The handler or service that triggered the deletion (e.g. `agent.delete`) */
  trigger: string;

  /**
   * Optional function that performs the actual delete. If provided, the
   * service logs first, then calls this function. If it throws, the log
   * entry remains (orphaned) and the error is re-thrown.
   *
   * The function should return a MongoDB `DeleteResult` (from `deleteOne`
   * or `deleteMany`) so the service can extract `deletedCount`. If it
   * returns something else, pass `count` explicitly.
   */
  deleteFn?: () => Promise<DeleteResult | void>;

  /** Optional MongoDB session for transactional use (not yet used in practice) */
  session?: ClientSession;

  /** Free-form metadata */
  metadata?: Record<string, unknown>;
}

/** Result returned by `logDeletion` */
export interface LogDeletionResult {
  /** The deletion log entry that was persisted */
  entry: DeletionLogEntry;
  /** The result of the delete operation (if `deleteFn` was provided) */
  deleteResult?: DeleteResult;
}

// ============================================================================
// SERVICE
// ============================================================================

export class DeletionLogService {
  private collection: Collection<DeletionLogEntry>;

  constructor(private db: Db) {
    this.collection = getDeletionLogCollection(db);
  }

  /**
   * Ensure indexes on the deletion_log collection.
   * Called during backend startup alongside other index creation.
   */
  async ensureIndexes(): Promise<void> {
    const { ensureDeletionLogIndexes } = await import('../models/deletion-log');
    await ensureDeletionLogIndexes(this.db);
    log.info('Deletion log service indexes ensured');
  }

  /**
   * Log a deletion and optionally perform the delete operation.
   *
   * **Semantics:** log-first, then delete. See the file-level JSDoc for the
   * full rationale and failure-mode analysis.
   *
   * @returns The persisted log entry and (if `deleteFn` was provided) the
   *          delete result.
   * @throws If the log write fails (delete is NOT performed).
   *         If the delete fails (log entry remains as orphan, error re-thrown).
   */
  async logDeletion(params: LogDeletionParams): Promise<LogDeletionResult> {
    const deletionLogId = `dl_${randomUUID()}`;
    const timestamp = Date.now();

    // Truncate docIds to MAX_DOC_IDS_STORED
    const allDocIds = params.docIds ?? [];
    const docIds = allDocIds.length > MAX_DOC_IDS_STORED
      ? allDocIds.slice(0, MAX_DOC_IDS_STORED)
      : allDocIds;

    // Determine count: explicit > docIds.length > 0
    const initialCount = params.count ?? docIds.length;

    // Build the log entry
    const entry: DeletionLogEntry = {
      deletionLogId,
      collection: params.collection,
      docIds,
      filterSummary: params.filterSummary,
      count: initialCount,
      reason: params.reason,
      actor: params.actor,
      trigger: params.trigger,
      timestamp,
      metadata: params.metadata,
    };

    // 1. Write the log entry FIRST (log-first strategy)
    //    If this fails, we abort — no delete is performed.
    await this.collection.insertOne(entry, { session: params.session });
    log.info(
      { deletionLogId, collection: params.collection, reason: params.reason, count: initialCount },
      'Deletion logged',
    );

    // 2. If a deleteFn was provided, execute it now
    let deleteResult: DeleteResult | undefined;
    if (params.deleteFn) {
      try {
        const result = await params.deleteFn();
        if (result && typeof result.deletedCount === 'number') {
          deleteResult = result;
          // Update the count in the log entry if it differs from our initial estimate
          if (result.deletedCount !== initialCount) {
            await this.collection.updateOne(
              { deletionLogId },
              { $set: { count: result.deletedCount } },
              { session: params.session },
            );
            entry.count = result.deletedCount;
            log.info(
              { deletionLogId, expectedCount: initialCount, actualCount: result.deletedCount },
              'Updated deletion log count after delete',
            );
          }
        }
      } catch (err) {
        // The delete failed but the log entry exists (orphaned).
        // This is the lesser evil — see file-level JSDoc for rationale.
        log.warn(
          { err, deletionLogId, collection: params.collection },
          'Delete operation failed after log entry was written — orphaned log entry exists',
        );
        throw err;
      }
    }

    return { entry, deleteResult };
  }

  /**
   * Query deletion log entries.
   *
   * @param filter - Optional filter criteria
   * @returns Array of matching entries, newest first
   */
  async query(filter: {
    collection?: string;
    actor?: string;
    reason?: DeletionReason;
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): Promise<DeletionLogEntry[]> {
    const query: Record<string, unknown> = {};
    if (filter.collection) query.collection = filter.collection;
    if (filter.actor) query.actor = filter.actor;
    if (filter.reason) query.reason = filter.reason;
    if (filter.startTime || filter.endTime) {
      query.timestamp = {};
      if (filter.startTime) (query.timestamp as Record<string, unknown>).$gte = filter.startTime;
      if (filter.endTime) (query.timestamp as Record<string, unknown>).$lte = filter.endTime;
    }

    return this.collection
      .find(query)
      .sort({ timestamp: -1 })
      .limit(filter.limit ?? 100)
      .toArray();
  }
}

// ============================================================================
// SINGLETON
// ============================================================================

let deletionLogInstance: DeletionLogService | null = null;

/**
 * Initialize the DeletionLogService singleton with a Db instance.
 * Called once during server bootstrap.
 */
export function initDeletionLogService(db: Db): DeletionLogService {
  deletionLogInstance = new DeletionLogService(db);
  return deletionLogInstance;
}

/**
 * Get the DeletionLogService singleton.
 * Returns null if not yet initialized.
 */
export function getDeletionLogService(): DeletionLogService | null {
  return deletionLogInstance;
}
