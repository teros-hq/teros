/**
 * Migration: every app gets an owner and a scope (MUW v2.2, 2026-11-02).
 *
 * Pablo's rule: migrations, not fallbacks. `App.installedBy` and `App.scope`
 * become required, so existing documents are completed here:
 *   - installedBy missing → the owner of the owning workspace.
 *   - scope missing → 'shared' for platform-provisioned apps (catalog
 *     availability.system, or mca.teros.core), 'personal' for the rest.
 * Apps whose workspace no longer exists are left untouched and reported.
 *
 * Idempotent: only $set on documents that lack the field.
 *
 * @spec MUW-REQ-10, MUW-REQ-11
 */
import type { Db } from 'mongodb'
import type { Migration } from './types.js'

const migration: Migration = {
  description: 'MUW v2.2: backfill App.installedBy (workspace owner) and App.scope (system → shared, rest → personal)',

  async up(db: Db): Promise<void> {
    const apps = db.collection('apps')
    const workspaces = db.collection('workspaces')
    const catalog = db.collection('mca_catalog')

    const systemMcaIds = new Set<string>(
      (await catalog.find({ 'availability.system': true }, { projection: { mcaId: 1 } }).toArray()).map((m) => m.mcaId as string),
    )
    systemMcaIds.add('mca.teros.core')

    const ownerByWorkspace = new Map<string, string>()
    for (const ws of await workspaces.find({}, { projection: { workspaceId: 1, ownerId: 1 } }).toArray()) {
      ownerByWorkspace.set(ws.workspaceId as string, ws.ownerId as string)
    }

    let owners = 0
    let scopes = 0
    let orphans = 0
    const cursor = apps.find({ $or: [{ installedBy: { $exists: false } }, { scope: { $exists: false } }] })
    for await (const app of cursor) {
      const set: Record<string, unknown> = {}
      if (!app.installedBy) {
        const owner = ownerByWorkspace.get(app.ownerId as string)
        if (!owner) {
          orphans++
          console.warn(`[20261102_002] app ${app.appId} (${app.name}) owner workspace ${app.ownerId} not found — skipped`)
          continue
        }
        set.installedBy = owner
        owners++
      }
      if (!app.scope) {
        set.scope = systemMcaIds.has(app.mcaId as string) ? 'shared' : 'personal'
        scopes++
      }
      if (Object.keys(set).length > 0) await apps.updateOne({ appId: app.appId }, { $set: set })
    }
    console.log(`[20261102_002] installedBy set on ${owners} app(s), scope set on ${scopes} app(s), ${orphans} orphan(s) skipped`)
  },
}

export default migration
