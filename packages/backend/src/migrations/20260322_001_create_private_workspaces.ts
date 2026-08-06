import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Generates a simple random ID with a given prefix.
 * Mirrors the generateId() utility used elsewhere in the backend.
 */
function generateId(prefix: string): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 24; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}_${id}`;
}

const migration: Migration = {
  description:
    'Create a Private Workspace for every existing user that does not have one, and set user.privateWorkspaceId. Also sets type="shared" on all existing workspaces that have no type.',

  async up(db: Db): Promise<void> {
    const users = db.collection('users');
    const workspaces = db.collection('workspaces');
    const volumes = db.collection('volumes');

    // -------------------------------------------------------------------------
    // 1. Backfill type='shared' on all existing workspaces without a type field
    // -------------------------------------------------------------------------
    const backfillResult = await workspaces.updateMany(
      { type: { $exists: false } },
      { $set: { type: 'shared' } },
    );
    if (backfillResult.modifiedCount > 0) {
      console.log(
        `[Migration] Backfilled type='shared' on ${backfillResult.modifiedCount} existing workspace(s)`,
      );
    }

    // -------------------------------------------------------------------------
    // 2. Create Private Workspace for each user that doesn't have one
    // -------------------------------------------------------------------------
    const allUsers = await users.find({ privateWorkspaceId: { $exists: false } }).toArray();
    console.log(
      `[Migration] Found ${allUsers.length} user(s) without a Private Workspace`,
    );

    for (const user of allUsers) {
      const userId: string = user.userId;

      // Idempotency check: maybe a private workspace already exists for this user
      const existing = await workspaces.findOne({ ownerId: userId, type: 'private' });
      if (existing) {
        // Workspace exists but user.privateWorkspaceId wasn't set — just link it
        await users.updateOne(
          { userId },
          { $set: { privateWorkspaceId: existing.workspaceId } },
        );
        console.log(
          `[Migration] Linked existing Private Workspace ${existing.workspaceId} to user ${userId}`,
        );
        continue;
      }

      // Create a volume for the private workspace
      const volumeId = generateId('vol_work');
      const now = new Date().toISOString();

      await volumes.insertOne({
        volumeId,
        name: 'Private',
        ownerId: userId,
        ownerType: 'workspace',
        hostPath: `/data/volumes/workspaces/${volumeId}`,
        createdAt: now,
        updatedAt: now,
      });

      // Create the private workspace
      const workspaceId = generateId('work');
      await workspaces.insertOne({
        workspaceId,
        name: 'Private',
        type: 'private',
        ownerId: userId,
        volumeId,
        members: [],
        settings: {},
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      // Link to user
      await users.updateOne(
        { userId },
        { $set: { privateWorkspaceId: workspaceId } },
      );

      console.log(
        `[Migration] Created Private Workspace ${workspaceId} (volume: ${volumeId}) for user ${userId}`,
      );
    }

    console.log('[Migration] Private Workspace creation complete.');
  },

  async down(db: Db): Promise<void> {
    const users = db.collection('users');
    const workspaces = db.collection('workspaces');
    const volumes = db.collection('volumes');

    // Find all private workspaces
    const privateWorkspaces = await workspaces.find({ type: 'private' }).toArray();

    for (const ws of privateWorkspaces) {
      // Remove the volume
      await volumes.deleteOne({ volumeId: ws.volumeId });
      // Remove the workspace
      await workspaces.deleteOne({ workspaceId: ws.workspaceId });
      // Unset privateWorkspaceId from the user
      await users.updateOne(
        { userId: ws.ownerId },
        { $unset: { privateWorkspaceId: '' } },
      );
      console.log(`[Migration] Removed Private Workspace ${ws.workspaceId} for user ${ws.ownerId}`);
    }

    // Revert type='shared' backfill (remove type field from workspaces that had none)
    // Note: we can't know which ones were backfilled vs explicitly set, so we remove
    // type='shared' from all — this is safe since 'shared' is the implicit default.
    await workspaces.updateMany(
      { type: 'shared' },
      { $unset: { type: '' } },
    );

    console.log('[Migration] Rollback complete.');
  },
};

export default migration;
