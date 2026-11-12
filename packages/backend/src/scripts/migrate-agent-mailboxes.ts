/**
 * Migration Script: agent mailboxes (tn_PcquTN30AawbK8uE, spec §3.8)
 *
 * One-time backfill of `agent_mailboxes` for existing agents:
 *
 * 1. ADOPT: agents that already use a mailbox (MAIL_ACCOUNT in user
 *    credentials for the email app) get their existing address registered in
 *    agent_mailboxes — the mailbox they already use is kept, not re-created
 *    (Nira's case: nira@agents.teros.ai created manually before the
 *    lifecycle existed). The Stalwart account id is resolved via x:Account.
 * 2. PROVISION: every OTHER agent with the email app granted gets a fresh
 *    auto-provisioned mailbox (clean-first naming) via AgentMailboxService.
 * 3. Agents WITHOUT the grant are left alone — the grant is the toggle; they
 *    get a mailbox when (and if) the human grants the app.
 *
 * Idempotent and re-runnable: agents that already have an agent_mailboxes
 * doc are skipped. A failure on one agent never aborts the batch.
 *
 * Usage:
 *   bun run src/scripts/migrate-agent-mailboxes.ts [--dry-run] [--adopt-only]
 */

import { MongoClient } from 'mongodb';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { secrets } from '../secrets/secrets-manager';
import { AuthManager } from '../auth/auth-manager';
import { AgentMailboxService } from '../services/agent-mailbox-service';
import { COLLECTIONS } from '../db';
import type { AgentInstance, AgentMailbox } from '../types/database';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);

async function migrate(dryRun: boolean, adoptOnly: boolean): Promise<void> {
  console.log('🔄 Migration: agent mailboxes (email lifecycle backfill)\n');
  if (dryRun) console.log('🔍 DRY RUN MODE — no changes will be made\n');
  if (adoptOnly) console.log('📥 ADOPT-ONLY MODE — existing mailboxes registered, no new provisioning\n');

  // Load secrets and connect to MongoDB
  const secretsPath = join(__dirname_local, '../../../../.secrets');
  (secrets as any).basePath = secretsPath;
  await secrets.load();

  const dbSecret = secrets.system('database');
  const mongoUri = process.env.MONGODB_URI || dbSecret?.uri || 'mongodb://localhost:27017';
  const mongoDatabase = process.env.MONGODB_DATABASE || dbSecret?.database || 'teros';

  const mongoClient = new MongoClient(mongoUri);
  await mongoClient.connect();
  const db = mongoClient.db(mongoDatabase);

  // AuthManager for legacy-mailbox detection (user_credentials, encrypted)
  const authManager = new AuthManager(db);

  const mailboxService = new AgentMailboxService(db, authManager);
  const mailboxes = db.collection<AgentMailbox>(COLLECTIONS.agentMailboxes);

  // The single email app (multi:false)
  const app = await db.collection('apps').findOne({ mcaId: 'mca.teros.email' });
  if (!app) {
    console.log('❌ No mca.teros.email app found — nothing to migrate. (Install it first.)');
    await mongoClient.close();
    return;
  }

  // All agents with the email app granted
  const grants = await db
    .collection('agent_app_access')
    .find({ appId: app.appId })
    .toArray();
  console.log(`Found ${grants.length} agent(s) with the email app granted.\n`);

  let adopted = 0;
  let provisioned = 0;
  let skipped = 0;
  let failed = 0;

  for (const grant of grants) {
    const agentId = grant.agentId as string;
    const tag = `[${agentId}]`;

    // Already migrated?
    const existing = await mailboxes.findOne({ agentId });
    if (existing) {
      console.log(`${tag} skip — already has mailbox ${existing.address} (${existing.status})`);
      skipped++;
      continue;
    }

    const agent = (await db.collection('agents').findOne({ agentId })) as unknown as AgentInstance | null;
    if (!agent) {
      console.log(`${tag} ❌ agent not found (stale grant) — skipped`);
      failed++;
      continue;
    }

    // ADOPT: does this agent already use a mailbox via legacy user secrets?
    const adoptedAddress = await mailboxService.findLegacyMailboxAddress(agent, app.appId);
    if (adoptedAddress) {
      if (dryRun) {
        console.log(`${tag} would ADOPT existing mailbox ${adoptedAddress}`);
        adopted++;
        continue;
      }
      try {
        const result = await mailboxService.adoptMailbox(agent, adoptedAddress);
        console.log(`${tag} ✅ adopted ${result.address} (${result.status})`);
        adopted++;
      } catch (error) {
        console.log(`${tag} ❌ adopt failed: ${error instanceof Error ? error.message : error}`);
        failed++;
      }
      continue;
    }

    if (adoptOnly) {
      console.log(`${tag} no legacy mailbox — left for lazy provisioning (adopt-only mode)`);
      skipped++;
      continue;
    }

    // PROVISION: fresh mailbox, clean-first naming
    if (dryRun) {
      console.log(`${tag} would PROVISION a fresh mailbox (clean-first)`);
      provisioned++;
      continue;
    }
    try {
      const result = await mailboxService.ensureMailbox(agent);
      console.log(
        `${tag} ✅ provisioned ${result.address} (${result.status}${result.reason ? ` — ${result.reason}` : ''})`,
      );
      provisioned++;
    } catch (error) {
      console.log(`${tag} ❌ provision failed: ${error instanceof Error ? error.message : error}`);
      failed++;
    }
  }

  console.log('\n==================================================');
  console.log(`Summary: ${adopted} adopted · ${provisioned} provisioned · ${skipped} skipped · ${failed} failed`);
  if (dryRun) console.log('(dry run — nothing was written)');
  await mongoClient.close();
}

const args = process.argv.slice(2);
migrate(args.includes('--dry-run'), args.includes('--adopt-only')).catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
