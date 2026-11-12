/**
 * One-off migration: replace bash-admin / filesystem-admin with Teros Remote (self-paired daemon on RAW).
 *
 * Context: task_674f6a80d7618a49 — Pablo's decision 2026-10-19. The spec
 * (docs/specs/remote/teros-remote.md, Goal 7) prescribes running the daemon on
 * the Teros host itself to replace the internal admin MCAs.
 *
 * What it does (idempotent, dry-run by default; pass --apply to write):
 *   1. Ensures a `mca.teros.remote` app instance exists for each workspace that
 *      currently has admin bash/filesystem apps (name: `remote-raw`).
 *   2. Sets the TEROS_REMOTE_KEY user credential for the workspace owner's user
 *      (the daemon's pairing key, passed via --key or env RAW_REMOTE_KEY).
 *   3. Grants the remote app to every agent that has a grant on any of the
 *      workspace's admin bash/filesystem apps.
 *   4. (--uninstall-old, only with --apply) Revokes the old grants and deletes
 *      the old admin app instances.
 *
 * Usage:
 *   cd /opt/teros && npx tsx --tsconfig packages/backend/tsconfig.json \
 *     scripts/migrate-admin-to-remote.ts --key trsk_... [--apply] [--uninstall-old]
 */

import { MongoClient } from 'mongodb';
import { generateAppId } from '@teros/core';
import { AuthManager } from '../packages/backend/src/auth/auth-manager';
import { McaService } from '../packages/backend/src/services/mca-service';
import { secrets } from '../packages/backend/src/secrets/secrets-manager';

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'teros';
const REMOTE_MCA_ID = 'mca.teros.remote';
const ADMIN_MCA_IDS = ['mca.teros.admin.bash', 'mca.teros.admin.filesystem'];
const REMOTE_APP_NAME = 'remote-raw';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const UNINSTALL_OLD = args.includes('--uninstall-old');
const keyIdx = args.indexOf('--key');
const RAW_KEY = keyIdx >= 0 ? args[keyIdx + 1] : process.env.RAW_REMOTE_KEY;

if (!RAW_KEY || !RAW_KEY.startsWith('trsk_')) {
  console.error('Missing --key trsk_... (or RAW_REMOTE_KEY env)');
  process.exit(1);
}

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);

  // AuthManager's encryption path uses the secrets singleton — load it like
  // the backend does (packages/backend/src/index.ts).
  (secrets as any).basePath = '/opt/teros/.secrets';
  await secrets.load();

  const authManager = new AuthManager(db);
  const mcaService = new McaService(db, { authManager });

  // The key is stored per-user. All workspaces here belong to Pablo.
  const ownerUserId = 'user_0000000000000000';

  // 1. Find all workspaces with admin bash/filesystem apps
  const adminApps = await db
    .collection('apps')
    .find({ mcaId: { $in: ADMIN_MCA_IDS }, status: 'active' })
    .toArray();
  const byWorkspace = new Map<string, typeof adminApps>();
  for (const app of adminApps) {
    const list = byWorkspace.get(app.ownerId) ?? [];
    list.push(app);
    byWorkspace.set(app.ownerId, list);
  }
  console.log(`Found ${adminApps.length} admin apps across ${byWorkspace.size} workspaces`);

  for (const [workspaceId, apps] of byWorkspace) {
    console.log(`\n=== Workspace ${workspaceId} (${apps.length} admin apps) ===`);

    // 2. Ensure remote app exists
    let remoteApp = await db.collection('apps').findOne({
      mcaId: REMOTE_MCA_ID,
      ownerId: workspaceId,
      name: REMOTE_APP_NAME,
    });
    if (!remoteApp) {
      const appId = generateAppId();
      console.log(`  Creating remote app ${appId} (${REMOTE_APP_NAME})... ${APPLY ? '' : '[dry-run]'}`);
      if (APPLY) {
        remoteApp = (await mcaService.createApp({
          appId,
          mcaId: REMOTE_MCA_ID,
          ownerId: workspaceId,
          ownerType: 'workspace',
          name: REMOTE_APP_NAME,
          status: 'active',
        })) as any;
      }
    } else {
      console.log(`  Remote app already exists: ${remoteApp.appId}`);
    }
    const remoteAppId = remoteApp?.appId ?? '(dry-run)';

    // 3. Set the credential.
    // NOTE: one daemon = one key = one app. This script is intended to be run
    // once per daemon instance (per workspace). Running it with the same key
    // for multiple workspaces would make the key resolve ambiguously — so we
    // only set the credential when the workspace matches --workspace (or when
    // there is exactly one workspace in scope).
    const wsIdx = args.indexOf('--workspace');
    const targetWorkspace = wsIdx >= 0 ? args[wsIdx + 1] : undefined;
    const shouldSetCredential = targetWorkspace ? workspaceId === targetWorkspace : byWorkspace.size === 1;
    if (APPLY && remoteApp && shouldSetCredential) {
      await authManager.set(ownerUserId, remoteApp.appId, REMOTE_MCA_ID, {
        TEROS_REMOTE_KEY: RAW_KEY,
      });
      console.log(`  Credential TEROS_REMOTE_KEY set for app ${remoteApp.appId}`);
    }

    // 4. Migrate grants
    const adminAppIds = apps.map((a) => a.appId);
    const grants = await db
      .collection('agent_app_access')
      .find({ appId: { $in: adminAppIds } })
      .toArray();
    const agentIds = [...new Set(grants.map((g) => g.agentId))];
    console.log(`  ${grants.length} admin grants across ${agentIds.length} agents`);

    for (const agentId of agentIds) {
      const existing = await db
        .collection('agent_app_access')
        .findOne({ agentId, appId: remoteAppId });
      if (existing) {
        console.log(`    agent ${agentId}: already has remote grant`);
        continue;
      }
      console.log(`    agent ${agentId}: grant remote ${APPLY ? '' : '[dry-run]'}`);
      if (APPLY && remoteApp) {
        await db.collection('agent_app_access').insertOne({
          agentId,
          appId: remoteApp.appId,
          grantedAt: new Date(),
          grantedBy: ownerUserId,
        });
      }
    }

    // 5. Revoke old grants + uninstall old apps (only with --uninstall-old)
    if (UNINSTALL_OLD && APPLY) {
      const delGrants = await db
        .collection('agent_app_access')
        .deleteMany({ appId: { $in: adminAppIds } });
      const delApps = await db.collection('apps').deleteMany({ appId: { $in: adminAppIds } });
      console.log(`  Removed ${delGrants.deletedCount} old grants, ${delApps.deletedCount} old apps`);
    }
  }

  await client.close();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
