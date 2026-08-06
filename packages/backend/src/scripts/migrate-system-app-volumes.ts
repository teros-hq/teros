/**
 * Migration Script: Add missing volume mounts to system apps
 *
 * System apps created before the resolveAppVolumes logic was added to ensureSystemApps()
 * may have `volumes: undefined`. This script finds all such apps and patches them with
 * the correct workspace volume.
 *
 * Usage:
 *   bun run src/scripts/migrate-system-app-volumes.ts [--dry-run]
 *
 * Options:
 *   --dry-run    Show what would be migrated without making changes
 */

import { MongoClient } from 'mongodb';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { secrets } from '../secrets/secrets-manager';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);

const SYSTEM_MCA_IDS = [
  'mca.teros.messaging',
  'mca.teros.scheduler',
  'mca.teros.conversations',
  'mca.teros.datetime',
  'mca.teros.memory',
  'mca.teros.file-processor',
  'mca.teros.feedback',
  'mca.teros.board-manager',
  'mca.teros.board-runner',
];

const MOUNT_PATH = '/workspace';

async function migrate(dryRun: boolean = false) {
  console.log('🔄 Migration: Add missing volume mounts to system apps\n');

  if (dryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be made\n');
  }

  // Load secrets and connect to MongoDB
  const secretsPath = join(__dirname_local, '../../../../.secrets');
  (secrets as any).basePath = secretsPath;
  await secrets.load();

  const dbSecret = secrets.system('database');
  const mongoUri = process.env.MONGODB_URI || dbSecret?.uri || 'mongodb://localhost:27017';
  const mongoDatabase = process.env.MONGODB_DATABASE || dbSecret?.database || 'teros';

  const mongoClient = new MongoClient(mongoUri);

  try {
    await mongoClient.connect();
    const db = mongoClient.db(mongoDatabase);

    const appsCollection = db.collection('apps');
    const workspacesCollection = db.collection('workspaces');

    // Find all system apps without a volume
    const appsWithoutVolume = await appsCollection
      .find({
        mcaId: { $in: SYSTEM_MCA_IDS },
        $or: [{ volumes: { $exists: false } }, { volumes: null }, { volumes: [] }],
      })
      .toArray();

    console.log(`📊 Found ${appsWithoutVolume.length} system apps without a volume mount\n`);

    if (appsWithoutVolume.length === 0) {
      console.log('✅ No migration needed — all system apps already have volumes!');
      return;
    }

    // Group by ownerId to batch workspace lookups
    const ownerIds = [...new Set(appsWithoutVolume.map((a) => a.ownerId as string))];
    console.log(`📦 Unique owners affected: ${ownerIds.length}\n`);

    // Build a map of ownerId → volumeId
    // All system apps should be workspace-owned (ownerType: 'workspace')
    // But handle user-owned as well via the users collection
    const volumeMap = new Map<string, string>();

    // Fetch workspace volumes
    const workspaceOwnerIds = appsWithoutVolume
      .filter((a) => a.ownerType === 'workspace' || !a.ownerType)
      .map((a) => a.ownerId as string);

    if (workspaceOwnerIds.length > 0) {
      const workspaces = await workspacesCollection
        .find({ workspaceId: { $in: [...new Set(workspaceOwnerIds)] } })
        .toArray();

      for (const ws of workspaces) {
        if (ws.volumeId) {
          volumeMap.set(ws.workspaceId as string, ws.volumeId as string);
        } else {
          console.warn(`  ⚠️  Workspace ${ws.workspaceId} has no volumeId — skipping its apps`);
        }
      }
    }

    // Fetch user volumes (fallback for legacy user-owned system apps)
    const userOwnerIds = appsWithoutVolume
      .filter((a) => a.ownerType === 'user')
      .map((a) => a.ownerId as string);

    if (userOwnerIds.length > 0) {
      const usersCollection = db.collection('users');
      const users = await usersCollection
        .find({ userId: { $in: [...new Set(userOwnerIds)] } })
        .toArray();

      for (const user of users) {
        if (user.volumeId) {
          volumeMap.set(user.userId as string, user.volumeId as string);
        } else {
          console.warn(`  ⚠️  User ${user.userId} has no volumeId — skipping their apps`);
        }
      }
    }

    console.log(`🗺️  Resolved ${volumeMap.size}/${ownerIds.length} owner volumes\n`);

    // Preview
    let migratable = 0;
    let skipped = 0;

    for (const app of appsWithoutVolume) {
      const volumeId = volumeMap.get(app.ownerId as string);
      if (volumeId) {
        migratable++;
        console.log(
          `  ✓ ${app.appId} (${app.mcaId}) → owner ${app.ownerId} → vol ${volumeId}`,
        );
      } else {
        skipped++;
        console.log(
          `  ✗ ${app.appId} (${app.mcaId}) → owner ${app.ownerId} → NO VOLUME (skipping)`,
        );
      }
    }

    console.log(`\n📋 Summary: ${migratable} to migrate, ${skipped} to skip\n`);

    if (dryRun) {
      console.log('🔍 DRY RUN — Skipping actual updates');
      return;
    }

    // Apply updates
    let updated = 0;
    let failed = 0;
    const now = new Date().toISOString();

    for (const app of appsWithoutVolume) {
      const volumeId = volumeMap.get(app.ownerId as string);
      if (!volumeId) {
        failed++;
        continue;
      }

      const volumes = [{ volumeId, mountPath: MOUNT_PATH }];

      const result = await appsCollection.updateOne(
        { appId: app.appId },
        { $set: { volumes, updatedAt: now } },
      );

      if (result.modifiedCount === 1) {
        updated++;
        console.log(`  ✅ Updated: ${app.appId} (${app.mcaId}) → ${volumeId}`);
      } else {
        failed++;
        console.error(`  ❌ Failed to update: ${app.appId}`);
      }
    }

    console.log(`\n🎉 Migration complete!`);
    console.log(`   Updated: ${updated} apps`);
    console.log(`   Skipped (no volume): ${failed} apps`);

    // Verify
    console.log('\n🔍 Verifying...');
    const remaining = await appsCollection.countDocuments({
      mcaId: { $in: SYSTEM_MCA_IDS },
      $or: [{ volumes: { $exists: false } }, { volumes: null }, { volumes: [] }],
    });

    console.log(`   System apps still without volume: ${remaining}`);

    if (remaining === 0) {
      console.log('\n✅ All system apps now have volume mounts!');
    } else {
      console.log(
        `\n⚠️  ${remaining} apps still missing volumes (likely owners with no volume configured).`,
      );
    }
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    await mongoClient.close();
  }
}

// Run if called directly
if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  migrate(dryRun)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { migrate };
