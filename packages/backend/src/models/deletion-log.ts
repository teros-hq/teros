/**
 * Deletion Log Model
 *
 * Permanent record of every document deletion in the platform.
 *
 * Design decision (Pablo, 2026-09-23): **nothing is ever deleted without
 * leaving a trace**. MongoDB TTL indexes silently remove expired documents
 * with no log, no tombstone, no audit trail — verified in production where
 * a `mca.teros.github.pull_request` subscription expired at ~08:10Z on
 * 2026-09-23 with zero trace. For full auditability that is unacceptable.
 *
 * This collection is the system of record for deletions. It has NO TTL of
 * its own — it is evidence.
 *
 * Separate from `audit_logs` by design: audit_logs captures security events
 * (logins, role changes, impersonation). deletion_log captures data-loss
 * events (document removals). Different consumers, different retention,
 * different query patterns.
 */

import type { Collection, Db, ObjectId } from 'mongodb';
import { COLLECTIONS, ensureCollectionIndexes } from '../db';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Why the deletion happened. New reasons can be added but existing ones
 * must never be removed or renamed — they are part of the audit record.
 */
export type DeletionReason =
  | 'channel_close'
  | 'app_uninstall'
  | 'expiry_cleanup'
  | 'soft_delete'
  | 'agent_delete'
  | 'project_delete'
  | 'user_delete'
  | 'subscription_cleanup'
  | 'other';

/**
 * A complete deletion log entry as stored in MongoDB.
 *
 * `docIds` is truncated to a maximum of `MAX_DOC_IDS_STORED` entries when
 * the deletion affects many documents. In that case `count` holds the true
 * total and `docIds` is a representative sample. When `count <= MAX_DOC_IDS_STORED`,
 * `docIds` contains every deleted id and `count === docIds.length`.
 */
export interface DeletionLogEntry {
  _id?: ObjectId;
  /** Unique identifier for this log entry (format: `dl_<uuid>`) */
  deletionLogId: string;

  /** Name of the MongoDB collection from which documents were deleted */
  collection: string;

  /**
   * Array of document ids that were deleted. Truncated to
   * `MAX_DOC_IDS_STORED` entries when the deletion is bulk. See `count`
   * for the true total.
   */
  docIds: string[];

  /**
   * Human-readable summary of the filter used (when the delete was by filter
   * rather than by explicit ids). Free-form string, not the raw filter object,
   * to avoid storing sensitive values.
   */
  filterSummary?: string;

  /** Total number of documents deleted (may exceed `docIds.length` for bulk deletes) */
  count: number;

  /** Why the deletion happened */
  reason: DeletionReason;

  /**
   * Who or what caused the deletion. For human actions: the userId.
   * For automated jobs: `system:<job-name>` (e.g. `system:ttl-sweeper`).
   */
  actor: string;

  /**
   * The handler or service that triggered the deletion (e.g. `agent.delete`,
   * `channel.close`, `subscription.expiry`).
   */
  trigger: string;

  /** When the deletion occurred (epoch ms) */
  timestamp: number;

  /** Free-form metadata for context that doesn't fit the structured fields */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Maximum number of document ids stored in `docIds`. When a bulk delete
 * removes more than this, only the first N are kept and `count` holds the
 * true total. 1000 is enough for single-id deletes and small batches while
 * keeping large bulk deletes from bloating the log entry.
 */
export const MAX_DOC_IDS_STORED = 1000;

// ============================================================================
// COLLECTION HELPERS
// ============================================================================

/**
 * Get the deletion_log collection from a Db instance.
 */
export function getDeletionLogCollection(db: Db): Collection<DeletionLogEntry> {
  return db.collection<DeletionLogEntry>('deletion_log');
}

/**
 * Ensure required indexes exist on the deletion_log collection.
 * Must be called once at startup (e.g. in bootstrap alongside other index creation).
 *
 * Indexes:
 * - `{ deletionLogId: 1 }` — unique, for direct lookups
 * - `{ collection: 1, timestamp: -1 }` — find deletions by collection, newest first
 * - `{ actor: 1, timestamp: -1 }` — find deletions by actor, newest first
 * - `{ timestamp: 1 }` — chronological scan / time-range queries
 */
export async function ensureDeletionLogIndexes(db: Db): Promise<void> {
  // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry with
  // ensureAllIndexes after migrations. Kept for tests and scripts.
  await ensureCollectionIndexes(getDeletionLogCollection(db), COLLECTIONS.deletionLog);

  console.log('[DeletionLog] MongoDB indexes ensured for deletion_log');
}
