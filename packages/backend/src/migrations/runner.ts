/**
 * Migration Runner
 *
 * Executes pending migrations in order and tracks them in the `_migrations` collection.
 *
 * Migration files are registered explicitly in the MIGRATIONS array below,
 * ordered by name (timestamp prefix guarantees correct execution order).
 * This approach is fully compatible with the project's TypeScript/tsx setup.
 *
 * Usage:
 *   await runMigrations(db)         — run all pending migrations at startup
 *   await runDown(db, migrationName) — rollback a specific migration (for debugging)
 */

import type { Collection, Db } from 'mongodb';
import type { Migration } from './types.js';

// ============================================================================
// MIGRATION REGISTRY
// Add new migrations here, in chronological order (name must match file name).
// ============================================================================

import migration_20260318_001 from './20260318_001_add_ttl_index_subscriptions_channel.js';
import migration_20260322_001 from './20260322_001_create_private_workspaces.js';
import migration_20260412_001 from './20260412_001_autoplay_v2_agent_project_relationships.js';
import migration_20260519_001 from './20260519_001_agent_usage.js';
import migration_20260520_001 from './20260520_001_leader_locks.js';
import migration_20260527_001 from './20260527_001_billing_last_billed_hour.js';
import migration_20260529_001 from './20260529_001_consolidate_agent_cores.js';
import migration_20260616_001 from './20260616_001_billing_invoice_idempotency.js';
import migration_20260616_002 from './20260616_002_billing_subscription_history.js';
import migration_20260616_003 from './20260616_003_billing_audit_trail.js';
import migration_20260617_001 from './20260617_001_billing_stripe.js';
import migration_20260617_002 from './20260617_002_rate_limit_counters.js';
import migration_20260617_003 from './20260617_003_billing_access_requests_boosts.js';
import migration_20260622_001 from './20260622_001_billing_invoice_user_status_index.js';
import migration_20260622_002 from './20260622_002_reconcile_plan_catalog.js';
import migration_20260623_001_billing from './20260623_001_billing_invoice_kind.js';
import migration_20260623_001_avatars from './20260623_001_normalize_avatar_urls.js';
import migration_20260630_001 from './20260630_001_backfill_default_teros_provider.js';
import migration_20260630_002 from './20260630_002_backfill_default_starter_subscription.js';
import migration_20260630_003 from './20260630_003_billing_rollout_amnesty_reset_usage.js';
import migration_20260630_004 from './20260630_004_llm_usage_message_id_index.js';
import migration_20260702_001 from './20260702_001_mca_tool_health.js';
import migration_20260703_001 from './20260703_001_super_agent_prompt_self_install.js';
import migration_20260704_001 from './20260704_001_agent_prompts_stop_on_broken_apps.js';
import migration_20260704_002 from './20260704_002_seed_explicit_tool_permissions.js';
import migration_20260704_003 from './20260704_003_pin_core_apps_direct_exposure.js';
import migration_20260708_001 from './20260708_001_agent_usage_rollup_runs.js';
import migration_20260708_002 from './20260708_002_agent_usage_perf_indexes.js';
import migration_20260708_003 from './20260708_003_agent_usage_access_log.js';

interface MigrationEntry {
  name: string;
  migration: Migration;
}

const MIGRATIONS: MigrationEntry[] = [
  {
    name: '20260318_001_add_ttl_index_subscriptions_channel',
    migration: migration_20260318_001,
  },
  {
    name: '20260322_001_create_private_workspaces',
    migration: migration_20260322_001,
  },
  {
    name: '20260412_001_autoplay_v2_agent_project_relationships',
    migration: migration_20260412_001,
  },
  {
    name: '20260519_001_agent_usage',
    migration: migration_20260519_001,
  },
  {
    name: '20260520_001_leader_locks',
    migration: migration_20260520_001,
  },
  {
    name: '20260527_001_billing_last_billed_hour',
    migration: migration_20260527_001,
  },
  {
    name: '20260529_001_consolidate_agent_cores',
    migration: migration_20260529_001,
  },
  {
    name: '20260616_001_billing_invoice_idempotency',
    migration: migration_20260616_001,
  },
  {
    name: '20260616_002_billing_subscription_history',
    migration: migration_20260616_002,
  },
  {
    name: '20260616_003_billing_audit_trail',
    migration: migration_20260616_003,
  },
  {
    name: '20260617_001_billing_stripe',
    migration: migration_20260617_001,
  },
  {
    name: '20260617_002_rate_limit_counters',
    migration: migration_20260617_002,
  },
  {
    name: '20260617_003_billing_access_requests_boosts',
    migration: migration_20260617_003,
  },
  {
    name: '20260622_001_billing_invoice_user_status_index',
    migration: migration_20260622_001,
  },
  {
    name: '20260622_002_reconcile_plan_catalog',
    migration: migration_20260622_002,
  },
  {
    name: '20260623_001_billing_invoice_kind',
    migration: migration_20260623_001_billing,
  },
  {
    name: '20260623_001_normalize_avatar_urls',
    migration: migration_20260623_001_avatars,
  },
  {
    name: '20260630_001_backfill_default_teros_provider',
    migration: migration_20260630_001,
  },
  {
    name: '20260630_002_backfill_default_starter_subscription',
    migration: migration_20260630_002,
  },
  {
    name: '20260630_003_billing_rollout_amnesty_reset_usage',
    migration: migration_20260630_003,
  },
  {
    name: '20260630_004_llm_usage_message_id_index',
    migration: migration_20260630_004,
  },
  {
    name: '20260702_001_mca_tool_health',
    migration: migration_20260702_001,
  },
  {
    name: '20260703_001_super_agent_prompt_self_install',
    migration: migration_20260703_001,
  },
  {
    name: '20260704_001_agent_prompts_stop_on_broken_apps',
    migration: migration_20260704_001,
  },
  {
    name: '20260704_002_seed_explicit_tool_permissions',
    migration: migration_20260704_002,
  },
  {
    name: '20260704_003_pin_core_apps_direct_exposure',
    migration: migration_20260704_003,
  },
  {
    name: '20260708_001_agent_usage_rollup_runs',
    migration: migration_20260708_001,
  },
  {
    name: '20260708_002_agent_usage_perf_indexes',
    migration: migration_20260708_002,
  },
  {
    name: '20260708_003_agent_usage_access_log',
    migration: migration_20260708_003,
  },
];

// ============================================================================
// INTERNAL TYPES
// ============================================================================

interface MigrationRecord {
  name: string;
  executedAt: Date;
}

function getMigrationsCollection(db: Db): Collection<MigrationRecord> {
  return db.collection<MigrationRecord>('_migrations');
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Run all pending migrations in order.
 * Skips migrations that have already been recorded in `_migrations`.
 * Called at backend startup, before the server begins accepting requests.
 */
export async function runMigrations(db: Db): Promise<void> {
  console.log('[Migrations] Checking for pending migrations...');

  const col = getMigrationsCollection(db);

  // Ensure an index on name for fast lookups
  await col.createIndex({ name: 1 }, { unique: true, name: 'migration_name_unique' });

  // Fetch already-executed migration names
  const executed = await col.find({}).toArray();
  const executedNames = new Set(executed.map((r) => r.name));

  const pending = MIGRATIONS.filter((entry) => !executedNames.has(entry.name));

  if (pending.length === 0) {
    console.log('[Migrations] All migrations are up to date.');
    return;
  }

  console.log(`[Migrations] Running ${pending.length} pending migration(s)...`);

  for (const entry of pending) {
    const { name, migration } = entry;

    if (!migration.down) {
      console.warn(
        `[Migrations] Warning: migration "${name}" has no down() — rollback will not be available.`,
      );
    }

    console.log(`[Migrations] Running: ${name} — ${migration.description}`);
    try {
      await migration.up(db);

      await col.insertOne({ name, executedAt: new Date() });
      console.log(`[Migrations] ✓ Completed: ${name}`);
    } catch (err) {
      console.error(`[Migrations] ✗ Failed: ${name}`, err);
      throw err; // Abort startup on migration failure
    }
  }

  console.log('[Migrations] All pending migrations completed.');
}

/**
 * Roll back a specific migration by name.
 * Useful for debugging and development.
 * Does NOT remove the migration record from `_migrations` automatically —
 * call this manually and then remove the record if needed.
 */
export async function runDown(db: Db, migrationName: string): Promise<void> {
  const entry = MIGRATIONS.find((e) => e.name === migrationName);
  if (!entry) {
    throw new Error(`[Migrations] Migration not found in registry: "${migrationName}"`);
  }

  const { migration } = entry;

  if (!migration.down) {
    throw new Error(
      `[Migrations] Migration "${migrationName}" does not implement down() — cannot rollback.`,
    );
  }

  console.log(`[Migrations] Rolling back: ${migrationName} — ${migration.description}`);
  await migration.down(db);

  // Remove from _migrations so it can be re-run if needed
  const col = getMigrationsCollection(db);
  await col.deleteOne({ name: migrationName });
  console.log(`[Migrations] ✓ Rolled back and removed record: ${migrationName}`);
}
