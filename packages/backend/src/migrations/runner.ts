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

import { randomUUID } from 'crypto';
import { hostname } from 'os';
import type { Collection, Db } from 'mongodb';
import { LEADER_LOCKS, LeaderElectionService } from '../services/leader-election.js';
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
import migration_20260629_001_automate from './20260629_001_automate_triggers.js';
import migration_20260630_001 from './20260630_001_backfill_default_teros_provider.js';
import migration_20260630_002 from './20260630_002_backfill_default_starter_subscription.js';
import migration_20260630_003 from './20260630_003_billing_rollout_amnesty_reset_usage.js';
import migration_20260630_004 from './20260630_004_llm_usage_message_id_index.js';
import migration_20260702_001 from './20260702_001_mca_tool_health.js';
import migration_20260703_001 from './20260703_001_super_agent_prompt_self_install.js';
import migration_20260704_001 from './20260704_001_agent_prompts_stop_on_broken_apps.js';
import migration_20260704_002 from './20260704_002_seed_explicit_tool_permissions.js';
import migration_20260704_003 from './20260704_003_pin_core_apps_direct_exposure.js';
import migration_20260707_001 from './20260707_001_skill_load_mode.js';
import migration_20260708_001 from './20260708_001_agent_usage_rollup_runs.js';
import migration_20260708_002 from './20260708_002_agent_usage_perf_indexes.js';
import migration_20260708_003 from './20260708_003_agent_usage_access_log.js';
import migration_20260814_001 from './20260814_001_board_events_and_daily_stats.js';
import migration_20260915_001 from './20260915_001_legacy_channels_private.js';
import migration_20260915_002 from './20260915_002_migrate_embedded_members_to_workspace_members.js';
import migration_20260917_001 from './20260917_001_session_messages_queue_state_index.js';
import migration_20260917_002 from './20260917_002_channel_messages_content_type_index.js';
import migration_20260917_003 from './20260917_003_channel_messages_user_role_index.js';
import migration_20260920_001 from './20260920_001_agent_apps_storage_indexes.js';
import migration_20260923_001 from './20260923_001_drop_evidence_ttl_indexes.js';
import migration_20260923_002 from './20260923_002_secondary_indexes.js';
import migration_20260926_001 from './20260926_001_remap_deprecated_fireworks_models.js';
import migration_20260930_001 from './20260930_001_reseed_stale_tool_permissions.js';
import migration_20261001_001 from './20261001_001_reseed_datetime_pure_tools_permissions.js';
import migration_20261001_002 from './20261001_002_reseed_datetime_pure_tools_permissions_per_entry.js';
import migration_20261002_001 from './20261002_001_voice_sessions_collection.js';
import migration_20261002_002 from './20261002_002_voice_telemetry_sessions_collection.js';
import migration_20261009_001 from './20261009_001_pricing_update_alvaro.js';
import migration_20261013_001 from './20261013_001_automate_model_v2.js';
import migration_20261013_002 from './20261013_002_import_scheduler_legacy.js';
import migration_20261014_001 from './20261014_001_fix_scheduler_action_types.js';
import migration_20261014_002 from './20261014_002_retire_scheduler.js';
import migration_20261014_003 from './20261014_003_task_artifacts.js';
import migration_20261014_004 from './20261014_004_automate_explicit_templates.js';
import migration_20261014_005 from './20261014_005_retire_docker_env.js';
import migration_20261015_001 from './20261015_001_automate_daily_execution_limits.js';
import migration_20261015_002 from './20261015_002_stripe_subs_with_card.js';
import migration_20261017_001 from './20261017_001_agent_model_hygiene.js';
import migration_20261017_002 from './20261017_002_conversation_indexes.js';
import migration_20261017_003 from './20261017_003_workspace_members_indexes.js';
import migration_20261017_004 from './20261017_004_backup_unique_indexes.js';
import migration_20261017_005 from './20261017_005_pseudonymize_deleted_users.js';
import migration_20261017_006 from './20261017_006_drop_identity_oauth_tokens.js';
import migration_20261017_007 from './20261017_007_hash_api_tokens.js';
import migration_20261017_008 from './20261017_008_encrypt_app_user_auth.js';
import migration_20261017_009 from './20261017_009_encrypt_totp_secrets.js';
import migration_20261017_010 from './20261017_010_channel_messages_workspace_id.js';
import migration_20261017_011 from './20261017_011_jsonschema_validators.js';
import migration_20261018_001 from './20261018_001_remote_devices_collection.js';
import migration_20261020_001 from './20261020_001_remote_device_bindings.js';
import migration_20261021_001 from './20261021_001_remove_available_providers.js';
import migration_20261024_001 from './20261024_001_todo_node_states.js';
import migration_20261030_001 from './20261030_001_system_capabilities_toggles.js';
import migration_20261030_002 from './20261030_002_reseed_mca_update_safe_tools.js';
import migration_20261102_001 from './20261102_001_drop_muw_enabled_flag.js';
import migration_20261102_002 from './20261102_002_app_owner_and_scope.js';
import migration_20261102_003 from './20261102_003_drop_app_user_auth.js';
import migration_20261102_004 from './20261102_004_apps_name_index.js';
import migration_20261102_005 from './20261102_005_channel_owner_is_a_user.js';
import migration_20261102_006 from './20261102_006_navbar_pins_seed.js';
import migration_20261103_001 from './20261103_001_teros_sizes.js';
import migration_20261104_001 from './20261104_001_rename_browser_mca.js';
import migration_20261109_001 from './20261109_001_teros_lanes.js';
import migration_20261109_002 from './20261109_002_conversation_summary_pref.js';

export interface MigrationEntry {
  name: string;
  migration: Migration;
}

export const MIGRATIONS: MigrationEntry[] = [
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
    name: '20260629_001_automate_triggers',
    migration: migration_20260629_001_automate,
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
    name: '20260707_001_skill_load_mode',
    migration: migration_20260707_001,
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
  {
    name: '20260814_001_board_events_and_daily_stats',
    migration: migration_20260814_001,
  },
  {
    name: '20260915_001_legacy_channels_private',
    migration: migration_20260915_001,
  },
  {
    name: '20260915_002_migrate_embedded_members_to_workspace_members',
    migration: migration_20260915_002,
  },
  {
    name: '20260917_001_session_messages_queue_state_index',
    migration: migration_20260917_001,
  },
  {
    name: '20260917_002_channel_messages_content_type_index',
    migration: migration_20260917_002,
  },
  {
    name: '20260917_003_channel_messages_user_role_index',
    migration: migration_20260917_003,
  },
  {
    name: '20260920_001_agent_apps_storage_indexes',
    migration: migration_20260920_001,
  },
  {
    name: '20260923_001_drop_evidence_ttl_indexes',
    migration: migration_20260923_001,
  },
  {
    name: '20260923_002_secondary_indexes',
    migration: migration_20260923_002,
  },
  {
    name: '20260926_001_remap_deprecated_fireworks_models',
    migration: migration_20260926_001,
  },
  {
    name: '20260930_001_reseed_stale_tool_permissions',
    migration: migration_20260930_001,
  },
  {
    name: '20261001_001_reseed_datetime_pure_tools_permissions',
    migration: migration_20261001_001,
  },
  {
    name: '20261001_002_reseed_datetime_pure_tools_permissions_per_entry',
    migration: migration_20261001_002,
  },
  {
    name: '20261002_001_voice_sessions_collection',
    migration: migration_20261002_001,
  },
  {
    name: '20261002_002_voice_telemetry_sessions_collection',
    migration: migration_20261002_002,
  },
  {
    name: '20261009_001_pricing_update_alvaro',
    migration: migration_20261009_001,
  },
  {
    name: '20261013_001_automate_model_v2',
    migration: migration_20261013_001,
  },
  {
    name: '20261013_002_import_scheduler_legacy',
    migration: migration_20261013_002,
  },
  {
    name: '20261014_001_fix_scheduler_action_types',
    migration: migration_20261014_001,
  },
  {
    name: '20261014_002_retire_scheduler',
    migration: migration_20261014_002,
  },
  {
    name: '20261014_003_task_artifacts',
    migration: migration_20261014_003,
  },
  {
    name: '20261014_004_automate_explicit_templates',
    migration: migration_20261014_004,
  },
  {
    name: '20261014_005_retire_docker_env',
    migration: migration_20261014_005,
  },
  {
    name: '20261015_001_automate_daily_execution_limits',
    migration: migration_20261015_001,
  },
  {
    name: '20261015_002_stripe_subs_with_card',
    migration: migration_20261015_002,
  },
  {
    name: '20261017_001_agent_model_hygiene',
    migration: migration_20261017_001,
  },
  {
    name: '20261017_002_conversation_indexes',
    migration: migration_20261017_002,
  },
  {
    name: '20261017_003_workspace_members_indexes',
    migration: migration_20261017_003,
  },
  {
    name: '20261017_004_backup_unique_indexes',
    migration: migration_20261017_004,
  },
  {
    name: '20261017_005_pseudonymize_deleted_users',
    migration: migration_20261017_005,
  },
  {
    name: '20261017_006_drop_identity_oauth_tokens',
    migration: migration_20261017_006,
  },
  {
    name: '20261017_007_hash_api_tokens',
    migration: migration_20261017_007,
  },
  {
    name: '20261017_008_encrypt_app_user_auth',
    migration: migration_20261017_008,
  },
  {
    name: '20261017_009_encrypt_totp_secrets',
    migration: migration_20261017_009,
  },
  {
    name: '20261017_010_channel_messages_workspace_id',
    migration: migration_20261017_010,
  },
  {
    name: '20261017_011_jsonschema_validators',
    migration: migration_20261017_011,
  },
  {
    name: '20261018_001_remote_devices_collection',
    migration: migration_20261018_001,
  },
  {
    name: '20261020_001_remote_device_bindings',
    migration: migration_20261020_001,
  },
  {
    name: '20261021_001_remove_available_providers',
    migration: migration_20261021_001,
  },
  {
    name: '20261024_001_todo_node_states',
    migration: migration_20261024_001,
  },
  {
    name: '20261030_001_system_capabilities_toggles',
    migration: migration_20261030_001,
  },
  {
    name: '20261030_002_reseed_mca_update_safe_tools',
    migration: migration_20261030_002,
  },
  {
    name: '20261102_001_drop_muw_enabled_flag',
    migration: migration_20261102_001,
  },
  {
    name: '20261102_002_app_owner_and_scope',
    migration: migration_20261102_002,
  },
  {
    name: '20261102_003_drop_app_user_auth',
    migration: migration_20261102_003,
  },
  {
    name: '20261102_004_apps_name_index',
    migration: migration_20261102_004,
  },
  {
    name: '20261102_005_channel_owner_is_a_user',
    migration: migration_20261102_005,
  },
  {
    name: '20261102_006_navbar_pins_seed',
    migration: migration_20261102_006,
  },
  {
    name: '20261103_001_teros_sizes',
    migration: migration_20261103_001,
  },
  {
    name: '20261104_001_rename_browser_mca',
    migration: migration_20261104_001,
  },
  {
    name: '20261109_001_teros_lanes',
    migration: migration_20261109_001,
  },
  {
    name: '20261109_002_conversation_summary_pref',
    migration: migration_20261109_002,
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

/** Lease on the migrations lock; renewed before each migration. */
const MIGRATION_LOCK_TTL_MS = 10 * 60_000;
/** How long an instance waits for another one to finish migrating. */
const MIGRATION_LOCK_WAIT_MS = 15 * 60_000;
const MIGRATION_LOCK_POLL_MS = 2_000;

export interface RunMigrationsOptions {
  /** Lock owner id (defaults to host:pid:random). Injected by tests. */
  ownerId?: string;
  /** Override the wait for another instance's lock (tests). */
  lockWaitMs?: number;
  lockPollMs?: number;
  /** Migration list to apply (defaults to MIGRATIONS). Injected by tests. */
  migrations?: MigrationEntry[];
}

/**
 * Run all pending migrations in order.
 * Skips migrations that have already been recorded in `_migrations`.
 * Called at backend startup, before the server begins accepting requests.
 *
 * Only one instance applies migrations at a time (INF-5): the run holds a
 * lease in `leader_locks`. Without it, two instances booting together (staging
 * runs 2) both ran up() — the second then hit E11000 on `_migrations` and
 * aborted boot, after a non-idempotent up() had already run twice. An instance
 * that finds the lock taken waits for it and then re-reads what is pending.
 */
export async function runMigrations(db: Db, opts: RunMigrationsOptions = {}): Promise<void> {
  console.log('[Migrations] Checking for pending migrations...');

  const col = getMigrationsCollection(db);

  // Ensure an index on name for fast lookups
  await col.createIndex({ name: 1 }, { unique: true, name: 'migration_name_unique' });

  const registry = opts.migrations ?? MIGRATIONS;
  if ((await pendingMigrations(col, registry)).length === 0) {
    console.log('[Migrations] All migrations are up to date.');
    return;
  }

  // The lock is only exclusive with the unique index on leader_locks.name. On a
  // fresh database that index doesn't exist yet (20260520_001 creates it), so
  // ensure it here with the exact same spec — a no-op once it exists.
  await db.collection('leader_locks').createIndex({ name: 1 }, { unique: true, name: 'name_unique' });

  const lock = new LeaderElectionService(db, opts.ownerId ?? `${hostname()}:${process.pid}:${randomUUID()}`);
  const waitUntil = Date.now() + (opts.lockWaitMs ?? MIGRATION_LOCK_WAIT_MS);
  while (!(await lock.tryAcquire(LEADER_LOCKS.Migrations, MIGRATION_LOCK_TTL_MS))) {
    if (Date.now() > waitUntil) {
      throw new Error('[Migrations] Another instance has held the migrations lock too long — aborting startup');
    }
    console.log('[Migrations] Another instance is migrating — waiting...');
    await new Promise((resolve) => setTimeout(resolve, opts.lockPollMs ?? MIGRATION_LOCK_POLL_MS));
  }

  try {
    // Re-read under the lock: whoever held it before may have run them all
    const pending = await pendingMigrations(col, registry);
    if (pending.length === 0) {
      console.log('[Migrations] All migrations are up to date.');
      return;
    }
    await applyMigrations(db, col, pending, lock);
  } finally {
    await lock.release(LEADER_LOCKS.Migrations);
  }
}

async function pendingMigrations(
  col: Collection<MigrationRecord>,
  registry: MigrationEntry[],
): Promise<MigrationEntry[]> {
  const executed = await col.find({}).toArray();
  const executedNames = new Set(executed.map((r) => r.name));
  return registry.filter((entry) => !executedNames.has(entry.name));
}

async function applyMigrations(
  db: Db,
  col: Collection<MigrationRecord>,
  pending: MigrationEntry[],
  lock: LeaderElectionService,
): Promise<void> {
  console.log(`[Migrations] Running ${pending.length} pending migration(s)...`);

  for (const entry of pending) {
    // Renew the lease before each step so a long run keeps it
    if (!(await lock.tryAcquire(LEADER_LOCKS.Migrations, MIGRATION_LOCK_TTL_MS))) {
      throw new Error('[Migrations] Lost the migrations lock mid-run — aborting startup');
    }

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
 * Also removes its record from `_migrations`, so the next boot re-runs it.
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
