import type { Db } from 'mongodb';
import { COLLECTIONS } from '../db/collections.js';
import { ensureIndexesFor } from '../db/indexes.js';
import type { Migration } from './types.js';

/**
 * Multi-workspace pairing (2026-10-20): create the `remote_device_bindings`
 * collection and migrate existing `remote_devices.appId` into binding rows.
 *
 * Each existing device with an appId gets exactly one binding — behavior is
 * identical to the current 1:1 model. New bindings are created by the gateway
 * on subsequent hellos when the same key matches multiple app instances.
 *
 * Idempotent: upsert semantics on (deviceId, appId) — safe to re-run.
 */
const migration: Migration = {
  description: 'Multi-workspace pairing: create remote_device_bindings + migrate existing appIds',

  async up(db: Db): Promise<void> {
    // 1. Ensure the new collection's indexes exist
    await ensureIndexesFor(db, [COLLECTIONS.remoteDeviceBindings]);

    // 2. Migrate existing remote_devices → remote_device_bindings
    const devices = db.collection(COLLECTIONS.remoteDevices);
    const bindings = db.collection(COLLECTIONS.remoteDeviceBindings);

    const cursor = devices.find({ appId: { $exists: true, $ne: null } });
    let migrated = 0;

    for await (const device of cursor) {
      const ts = new Date();
      await bindings.updateOne(
        { deviceId: device.deviceId, appId: device.appId },
        {
          $set: {
            workspaceId: device.workspaceId,
            ownerId: device.ownerId,
            tokenHash: device.tokenHash,
            status: device.status === 'revoked' ? 'revoked' : 'active',
            updatedAt: ts,
          },
          $setOnInsert: {
            deviceId: device.deviceId,
            appId: device.appId,
            boundAt: device.createdAt ?? ts,
          },
        },
        { upsert: true },
      );
      migrated++;
    }

    console.log(
      `[Migration] Created remote_device_bindings + migrated ${migrated} existing device(s)`,
    );
  },

  async down(db: Db): Promise<void> {
    // Drop the bindings collection entirely — remote_devices still has appId
    // so the old 1:1 model keeps working.
    try {
      await db.dropCollection(COLLECTIONS.remoteDeviceBindings);
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code !== 26) throw err; // NamespaceNotFound — already gone
    }
    console.log('[Migration] Dropped remote_device_bindings collection');
  },
};

export default migration;
