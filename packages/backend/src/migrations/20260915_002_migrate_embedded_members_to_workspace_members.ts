/**
 * Migration: Migrate embedded workspace.members[] to workspace_members collection
 *
 * This is a one-time migration that:
 * 1. For every workspace, reads the embedded `members` array
 * 2. For each member, upserts into `workspace_members` (if not already there)
 * 3. After verifying all entries are migrated, removes the `members` field from
 *    workspace documents ($unset: { members: "" })
 *
 * Idempotent: workspaces without a `members` field match nothing, so re-runs
 * are safe. Already-migrated entries in `workspace_members` are not duplicated
 * (upsert with $setOnInsert).
 *
 * @author nira - 2026.09.15
 */

import type { Db } from 'mongodb';
import type { Migration } from './types.js';

interface EmbeddedMember {
  userId?: string;
  role: string;
  joinedAt: string;
  addedBy: string;
  status?: string;
  email?: string;
  invitation?: any;
}

const migration: Migration = {
  description: 'Migrate embedded workspace.members[] to workspace_members collection, then $unset the field',

  async up(db: Db): Promise<void> {
    console.log('[Migration] migrate_embedded_members: starting...');

    // 1. Find all workspaces that still have a `members` field
    const workspacesWithMembers = await db
      .collection('workspaces')
      .find({ members: { $exists: true, $ne: [] } })
      .toArray();

    console.log(
      `[Migration] migrate_embedded_members: found ${workspacesWithMembers.length} workspaces with embedded members`,
    );

    let totalMigrated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    for (const ws of workspacesWithMembers) {
      const members = ws.members as EmbeddedMember[];
      if (!members || members.length === 0) continue;

      for (const member of members) {
        try {
          if (member.userId) {
            // Active members with a userId
            await db.collection('workspace_members').updateOne(
              { workspaceId: ws.workspaceId, userId: member.userId },
              {
                $setOnInsert: {
                  workspaceId: ws.workspaceId,
                  userId: member.userId,
                  role: member.role,
                  joinedAt: member.joinedAt,
                  addedBy: member.addedBy,
                  status: member.status ?? 'active',
                  email: member.email,
                  invitation: member.invitation,
                },
              },
              { upsert: true },
            );
            totalMigrated++;
          } else if (member.email && member.status === 'pending') {
            // Pending members (no userId, keyed by email)
            await db.collection('workspace_members').updateOne(
              { workspaceId: ws.workspaceId, email: member.email, status: 'pending' },
              {
                $setOnInsert: {
                  workspaceId: ws.workspaceId,
                  role: member.role,
                  joinedAt: member.joinedAt,
                  addedBy: member.addedBy,
                  status: 'pending',
                  email: member.email,
                  invitation: member.invitation,
                },
              },
              { upsert: true },
            );
            totalMigrated++;
          } else {
            totalSkipped++;
            console.warn(
              `[Migration] migrate_embedded_members: skipping member with no userId or pending email in workspace ${ws.workspaceId}`,
            );
          }
        } catch (e) {
          totalErrors++;
          console.error(
            `[Migration] migrate_embedded_members: error migrating member in workspace ${ws.workspaceId}:`,
            e,
          );
        }
      }
    }

    console.log(
      `[Migration] migrate_embedded_members: migrated=${totalMigrated}, skipped=${totalSkipped}, errors=${totalErrors}`,
    );

    if (totalErrors > 0) {
      throw new Error(
        `migrate_embedded_members: ${totalErrors} errors occurred — NOT removing embedded members field. Fix errors and re-run.`,
      );
    }

    // 2. Verify: count workspace_members entries vs embedded members
    const totalEmbedded = workspacesWithMembers.reduce(
      (sum, ws) => sum + ((ws.members as EmbeddedMember[])?.length ?? 0),
      0,
    );
    const totalInCollection = await db.collection('workspace_members').countDocuments({
      workspaceId: { $in: workspacesWithMembers.map((w) => w.workspaceId) },
    });

    console.log(
      `[Migration] migrate_embedded_members: verification — embedded=${totalEmbedded}, collection=${totalInCollection}`,
    );

    if (totalInCollection < totalMigrated) {
      throw new Error(
        'migrate_embedded_members: verification failed — collection has fewer entries than migrated. NOT removing embedded field.',
      );
    }

    // 3. Remove the `members` field from all workspace documents
    const unsetResult = await db
      .collection('workspaces')
      .updateMany(
        { members: { $exists: true } },
        { $unset: { members: '' } },
      );

    console.log(
      `[Migration] migrate_embedded_members: ✓ complete — removed embedded field from ${unsetResult.modifiedCount} workspace documents`,
    );
  },

  async down(db: Db): Promise<void> {
    // Re-add empty members array to all workspaces (best-effort rollback)
    await db
      .collection('workspaces')
      .updateMany(
        { members: { $exists: false } },
        { $set: { members: [] } },
      );
    console.log('[Migration] migrate_embedded_members: rolled back — re-added empty members arrays');
  },
};

export default migration;
