/**
 * Browser MCA rename (spec docs/specs/20261104_browser-mca-rename.md, BRN-REQ-2):
 * `mca.teros.playwright` → `mca.teros.browser` in every collection that
 * stores the id. Idempotent; `down` restores the ids.
 *
 *   apps.mcaId                          old → new (name, appId, grants untouched)
 *   agents.enabledSystemApps[]          old → new, once
 *   agents.disabledSystemApps[]         old → new, once
 *   mca_tool_health.mcaId               old → new
 *   tool_executions.mcaId               old → new (history, for consistency)
 *   mca_catalog { mcaId: old }          deleted — sync-mcas recreates it from
 *                                       the renamed manifest at the next start
 */

import type { Db } from 'mongodb'
import type { Migration } from './types.js'

export const OLD_ID = 'mca.teros.playwright'
export const NEW_ID = 'mca.teros.browser'

/**
 * Every MCA id rename the data must follow. `sync-mcas` applies these BEFORE
 * it deletes orphaned apps (the start script runs it before the backend's
 * migrations, and an app whose MCA id vanished from the catalog counts as an
 * orphan) — see BRN-REQ-2.
 */
export const MCA_ID_RENAMES: ReadonlyArray<{ from: string; to: string }> = [{ from: OLD_ID, to: NEW_ID }]

/** Apply every known rename (idempotent). Used by the migration and by sync-mcas. */
export async function applyMcaIdRenames(db: Db): Promise<void> {
  for (const { from, to } of MCA_ID_RENAMES) await renameIn(db, from, to)
}

async function renameIn(db: Db, from: string, to: string): Promise<void> {
  await db.collection('apps').updateMany({ mcaId: from }, { $set: { mcaId: to } })
  for (const field of ['enabledSystemApps', 'disabledSystemApps']) {
    // Agents that already list `to` just lose `from`; the rest get `from` replaced.
    await db.collection('agents').updateMany({ [field]: { $all: [from, to] } }, { $pull: { [field]: from } } as never)
    await db.collection('agents').updateMany({ [field]: from }, { $set: { [`${field}.$`]: to } })
  }
  for (const name of ['mca_tool_health', 'tool_executions']) {
    const names = await db.listCollections({ name }).toArray()
    if (names.length === 0) continue
    await db.collection(name).updateMany({ mcaId: from }, { $set: { mcaId: to } })
  }
}

const migration: Migration = {
  description: 'Browser MCA rename (BRN): mca.teros.playwright → mca.teros.browser in apps, agent capability toggles, tool health and executions; old catalog entry dropped for sync-mcas to recreate',

  async up(db: Db): Promise<void> {
    await applyMcaIdRenames(db)
    await db.collection('mca_catalog').deleteMany({ mcaId: OLD_ID })
  },

  async down(db: Db): Promise<void> {
    await renameIn(db, NEW_ID, OLD_ID)
    // The catalog entry is recreated by sync-mcas from whichever manifest is checked out.
    await db.collection('mca_catalog').deleteMany({ mcaId: NEW_ID })
  },
}

export default migration
