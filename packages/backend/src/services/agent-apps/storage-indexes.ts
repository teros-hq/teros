/**
 * Agent Apps Storage — MongoDB Index Management
 *
 * Provides:
 *   - ensureStorageIndexes(db): creates indexes on the two STATIC collections
 *     (agent_app_installations, agent_app_objects) during bootstrap.
 *   - ensureDynamicCollectionIndexes(db, collectionName): creates indexes on
 *     a dynamic `agent_app_storage_*` collection the first time it is used.
 *
 * Dynamic collections are created at runtime by MCAs via sanitizeCollectionName().
 * We cannot index them at bootstrap because they don't exist yet. Instead,
 * CallbackHandlers calls ensureDynamicCollectionIndexes() on the first
 * storage_put to each collection. An in-memory Set tracks which collections
 * have already been indexed in this process to avoid redundant createIndex
 * calls (createIndex is idempotent in MongoDB, so the Set is just an
 * optimization — it resets on restart and that's fine).
 */

import type { Db } from 'mongodb';
import { COLLECTIONS, ensureIndexesFor } from '../../db';
import { ensureAgentAppStorageIndexes } from '../../db/indexes';

// ---------------------------------------------------------------------------
// Static collection indexes (called at bootstrap)
// ---------------------------------------------------------------------------

/**
 * Ensure indexes for the two static AgentApps storage collections.
 * Called during server bootstrap, after the DB connection is available.
 *
 * Collections:
 *   - agent_app_installations
 *       • unique index on installationId
 *       • index on workspaceId
 *       • index on status
 *   - agent_app_objects
 *       • unique index on objectId
 *       • index on installationId (for list queries)
 */
export async function ensureStorageIndexes(db: Db): Promise<void> {
  // Declared in src/db/indexes.ts (GOV-4); also created by migration 20260920_001.
  await ensureIndexesFor(db, [COLLECTIONS.agentAppInstallations, COLLECTIONS.agentAppObjects]);
}

// ---------------------------------------------------------------------------
// Dynamic collection indexes (called on first storage_put)
// ---------------------------------------------------------------------------

/**
 * In-memory set of collection names that have already been indexed in this
 * process. This avoids calling createIndex on every storage_put — we only
 * index the first time we see a collection. The set resets on restart, which
 * is fine because createIndex is idempotent in MongoDB.
 */
const indexedCollections = new Set<string>();

/**
 * Ensure indexes on a dynamic `agent_app_storage_*` collection.
 *
 * Called by CallbackHandlers.handleStoragePut() the first time a collection
 * is used. Creates:
 *   - Unique compound index on _installationId + _documentId
 *     (ensures one document per installationId + documentId pair, and
 *      makes upsert/find by these fields efficient)
 *   - Index on _installationId
 *     (makes storage_query efficient — all queries are scoped by installationId)
 *
 * @param db MongoDB database handle
 * @param collectionName The full collection name (e.g. "agent_app_storage_mydata")
 */
export async function ensureDynamicCollectionIndexes(
  db: Db,
  collectionName: string,
): Promise<void> {
  // Fast path — already indexed in this process
  if (indexedCollections.has(collectionName)) return;

  // Safety check — only index agent_app_storage_* collections
  if (!collectionName.startsWith('agent_app_storage_')) {
    throw new Error(
      `ensureDynamicCollectionIndexes: refusing to index non-storage collection '${collectionName}'`,
    );
  }

  // Unique (_installationId, _documentId) for put/get, plus _installationId
  // alone for storage_query — declared in src/db/indexes.ts (AGENT_APP_STORAGE_INDEXES).
  await ensureAgentAppStorageIndexes(db, collectionName);

  // Mark as indexed so we don't repeat the createIndex calls
  indexedCollections.add(collectionName);
}

// ---------------------------------------------------------------------------
// Test helper — clears the in-memory set (for unit tests only)
// ---------------------------------------------------------------------------

/**
 * Clear the in-memory tracking set. Intended for unit tests that need to
 * simulate a fresh process. Not exported through the public API.
 */
export function _resetIndexedCollectionsForTests(): void {
  indexedCollections.clear();
}
