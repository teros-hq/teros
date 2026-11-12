/**
 * Migration: every active workspace gets its factory navbar pins (NAV-REQ-7).
 *
 * Migrations, not fallbacks: the client never invents a default zone — the
 * rows exist in `navbar_pins` from this migration (existing workspaces) and
 * from the workspace-created hook (new ones). Idempotent: a workspace that
 * already has a factory pin is skipped.
 *
 * @spec NAV-REQ-7
 */
import type { Db } from 'mongodb'
import type { Migration } from './types.js'
import { NavbarPinsService } from '../services/navbar-pins-service.js'

const migration: Migration = {
  description: 'Navbar v5: seed the factory pins of every active workspace',

  async up(db: Db): Promise<void> {
    // The service only needs the db for seeding; access checks are not involved.
    const service = new NavbarPinsService(db, null as never, null)
    const workspaces = await db
      .collection('workspaces')
      .find({ status: 'active' }, { projection: { workspaceId: 1, ownerId: 1 } })
      .toArray()
    let seeded = 0
    let skipped = 0
    for (const ws of workspaces) {
      const n = await service.seedFactoryPins(ws.workspaceId as string, ws.ownerId as string)
      if (n > 0) seeded++
      else skipped++
    }
    console.log(`[20261102_006] factory pins seeded in ${seeded} workspace(s), ${skipped} already had them`)
  },
}

export default migration
