import type { Db } from "mongodb"
import type { Migration } from "./types.js"
import { ensureStorageIndexes } from "../services/agent-apps/storage-indexes.js"

/**
 * Agent Apps storage — static collection indexes.
 *
 * The indexes on `agent_app_installations` and `agent_app_signed_urls` were
 * originally created via `ensureStorageIndexes(db)` in the server bootstrap
 * (server-bootstrap.ts). `createIndex` is idempotent in MongoDB, so this works,
 * but there was no record in `_migrations` and no migration file — meaning the
 * indexes were not traceable or reproducible across environments.
 *
 * This migration formalises them: it calls the same `ensureStorageIndexes(db)`
 * function, so the logic lives in one place, and the execution is recorded in
 * `_migrations` for traceability.
 *
 * No `down` is provided — the indexes are safe to leave in place even if the
 * Agent Apps storage feature is reverted. Dropping them would risk breaking
 * any remaining data or queries that still reference these collections.
 */

const migration: Migration = {
  description:
    "Agent Apps storage: create indexes on agent_app_installations and agent_app_objects (ensureStorageIndexes)",

  async up(db: Db): Promise<void> {
    await ensureStorageIndexes(db)
    console.log(
      "[Migration] Ensured Agent Apps storage indexes (agent_app_installations, agent_app_objects)",
    )
  },
}

export default migration
