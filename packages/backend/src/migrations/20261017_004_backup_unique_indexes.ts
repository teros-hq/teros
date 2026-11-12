import type { Db } from "mongodb"
import { dropIndexIfExists, ensureIndex } from "./helpers.js"
import type { Migration } from "./types.js"

/**
 * Unique indexes backing check-then-insert code paths (MOD-5,
 * docs/audit/20261008_audit-data-layer.md). Without them two concurrent
 * requests both pass the "does it exist?" check and both insert.
 *
 * - workspaces: one private workspace per owner (createPrivateWorkspace).
 * - user_providers: one Teros provider per user (ensureDefaultTerosProvider)
 *   and at most one default provider per user (provider.update clears the
 *   others first, so a concurrent second default now fails instead of
 *   leaving two).
 *
 * Duplicates already in the data make ensureIndex fall back to a non-unique
 * index with a warning — clean them up and re-run if that happens.
 */
const migration: Migration = {
  description:
    "Backup unique indexes: one private workspace per owner, one Teros provider and one default provider per user",

  async up(db: Db): Promise<void> {
    await ensureIndex(
      db,
      "workspaces",
      { ownerId: 1 },
      {
        name: "ownerId_private_unique",
        unique: true,
        partialFilterExpression: { type: "private" },
      },
    )
    await ensureIndex(
      db,
      "user_providers",
      { userId: 1 },
      {
        name: "userId_teros_unique",
        unique: true,
        partialFilterExpression: { providerType: "teros" },
      },
    )
    await ensureIndex(
      db,
      "user_providers",
      { userId: 1 },
      { name: "userId_default_unique", unique: true, partialFilterExpression: { isDefault: true } },
    )
    console.log("[Migration] backup unique indexes")
  },

  async down(db: Db): Promise<void> {
    await dropIndexIfExists(db, "workspaces", "ownerId_private_unique")
    await dropIndexIfExists(db, "user_providers", "userId_teros_unique")
    await dropIndexIfExists(db, "user_providers", "userId_default_unique")
  },
}

export default migration
