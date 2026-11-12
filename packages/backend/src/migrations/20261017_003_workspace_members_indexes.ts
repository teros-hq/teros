import type { Db } from "mongodb"
import { dropIndexIfExists, ensureIndex } from "./helpers.js"
import type { Migration } from "./types.js"

/**
 * workspace_members uniqueness (INF-6, MOD-5 — docs/audit/20261008_audit-data-layer.md).
 *
 * The {workspaceId, userId} index was `unique + sparse`. A sparse COMPOUND
 * index still indexes a document that has ANY of its fields, so pending
 * invitations (inserted without userId) were indexed as (workspaceId, null):
 * the second pending invitation to the same workspace failed with E11000.
 *
 * - Replaced by a unique index that only covers rows with a real userId
 *   (partialFilterExpression userId: string).
 * - New unique index on {workspaceId, email} over pending rows, so the same
 *   address can't be invited twice in a race (check-then-insert, MOD-5).
 *
 * WorkspaceService.ensureIndexes no longer creates the compound index (it runs
 * before migrations at boot and would collide with this one).
 */
const migration: Migration = {
  description:
    "workspace_members: replace sparse unique {workspaceId,userId} with a partial one (userId string); unique pending {workspaceId,email}",

  async up(db: Db): Promise<void> {
    await dropIndexIfExists(db, "workspace_members", "workspaceId_1_userId_1")
    await ensureIndex(
      db,
      "workspace_members",
      { workspaceId: 1, userId: 1 },
      {
        name: "workspaceId_userId_unique",
        unique: true,
        partialFilterExpression: { userId: { $type: "string" } },
      },
    )
    await ensureIndex(
      db,
      "workspace_members",
      { workspaceId: 1, email: 1 },
      {
        name: "workspaceId_email_pending_unique",
        unique: true,
        partialFilterExpression: { status: "pending" },
      },
    )
    console.log("[Migration] workspace_members uniqueness indexes")
  },

  async down(db: Db): Promise<void> {
    await dropIndexIfExists(db, "workspace_members", "workspaceId_userId_unique")
    await dropIndexIfExists(db, "workspace_members", "workspaceId_email_pending_unique")
    await db
      .collection("workspace_members")
      .createIndex({ workspaceId: 1, userId: 1 }, { unique: true, sparse: true })
  },
}

export default migration
