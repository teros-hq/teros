/**
 * Migration: drop the `muw.enabled` feature flag.
 *
 * Multi-user workspaces are on for everybody in every environment (Pablo,
 * 2026-11-02): the flag left the registry (packages/shared/src/feature-flags.ts)
 * and every read-time check behind it became unconditional. The registry sync
 * never deletes documents, so the stale flag, its overrides and its audit rows
 * would linger in every database and show up in the admin console as an
 * "unknown" flag. This removes them.
 *
 * Idempotent: deleteMany on an exact key.
 *
 * @spec MUW-REQ-19 (retired)
 */
import type { Db } from 'mongodb'
import type { Migration } from './types.js'

const KEY = 'muw.enabled'

const migration: Migration = {
  description: 'Drop the retired muw.enabled feature flag (definition, overrides, audit log)',

  async up(db: Db): Promise<void> {
    const flags = await db.collection('feature_flags').deleteMany({ key: KEY })
    const overrides = await db.collection('feature_flag_overrides').deleteMany({ key: KEY })
    const audit = await db.collection('feature_flag_audit_log').deleteMany({ key: KEY })
    console.log(
      `[20261102_001] removed muw.enabled: ${flags.deletedCount} flag, ${overrides.deletedCount} override(s), ${audit.deletedCount} audit row(s)`,
    )
  },

  // No down: the flag no longer exists in code, so re-creating the document
  // would only resurrect an unknown key.
}

export default migration
