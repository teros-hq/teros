import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Retire the deprecated `mca.teros.docker-env` MCA.
 *
 * The Docker Environments MCA (which mounted the host Docker socket into a
 * per-workspace container) has been removed from the codebase as part of the
 * datastore-isolation security workstream. Its source dir, runtime image,
 * frontend renderer, network-policy grant and backend spawn special-case are
 * all gone. This migration deterministically retires whatever installs and
 * state still live in the database at boot, so a freshly-pulled backend lands
 * in a consistent state without waiting on sync-mcas.
 *
 * What it removes:
 *   1. `apps` rows with `mcaId === 'mca.teros.docker-env'` (the per-workspace
 *      installs).
 *   2. `agent_app_access` grants pointing at those apps (resolved by appId
 *      before the apps are deleted).
 *   3. The `mca_catalog` entry for `mca.teros.docker-env`.
 *   4. The `docker_envs` collection — the MCA's own ephemeral state (one doc
 *      per provisioned environment). Nothing else reads it, and it is the one
 *      piece that sync-mcas' orphaned-app auto-prune does NOT clean, so it has
 *      to be dropped explicitly here.
 *
 * sync-mcas' deleteOrphanedApps would eventually remove (1) and (2) once the
 * MCA is no longer in the manifest list, but doing it here is deterministic
 * and self-contained, and lets this migration also handle (3) and (4) which
 * that path does not.
 *
 * Idempotent: every step matches nothing on a second run. No `down()` — this
 * is a one-way retirement of a removed feature; there is nothing to restore
 * (the source, image and catalog definition no longer exist).
 */
const DOCKER_ENV_MCA_ID = 'mca.teros.docker-env';

const migration: Migration = {
  description: 'Retire deprecated mca.teros.docker-env: delete its apps, access grants, catalog entry and drop docker_envs',

  async up(db: Db): Promise<void> {
    // 1. Find the installs so we can clean up their access grants by appId.
    const apps = await db
      .collection('apps')
      .find({ mcaId: DOCKER_ENV_MCA_ID })
      .toArray();
    const appIds = apps.map((a) => a.appId).filter((id): id is string => typeof id === 'string');

    // 2. Delete agent_app_access grants for those apps.
    if (appIds.length > 0) {
      const accessResult = await db
        .collection('agent_app_access')
        .deleteMany({ appId: { $in: appIds } });
      console.log(
        `[20261014_005] Deleted ${accessResult.deletedCount} agent_app_access grant(s) for ${appIds.length} docker-env app(s)`,
      );
    }

    // 3. Delete the apps themselves.
    const appsResult = await db
      .collection('apps')
      .deleteMany({ mcaId: DOCKER_ENV_MCA_ID });
    console.log(`[20261014_005] Deleted ${appsResult.deletedCount} mca.teros.docker-env app(s)`);

    // 4. Delete the catalog entry.
    const catalogResult = await db
      .collection('mca_catalog')
      .deleteOne({ mcaId: DOCKER_ENV_MCA_ID });
    console.log(
      `[20261014_005] Deleted ${catalogResult.deletedCount} mca_catalog entry for ${DOCKER_ENV_MCA_ID}`,
    );

    // 5. Drop the docker_envs collection (the MCA's own ephemeral state).
    //    Only drop it if it exists — dropping a missing collection throws
    //    NamespaceNotFound (26) on some drivers, so guard with a listing.
    const existing = await db.listCollections({ name: 'docker_envs' }).toArray();
    if (existing.length > 0) {
      await db.collection('docker_envs').drop();
      console.log('[20261014_005] Dropped docker_envs collection');
    } else {
      console.log('[20261014_005] docker_envs collection not present — nothing to drop');
    }
  },
};

export default migration;
