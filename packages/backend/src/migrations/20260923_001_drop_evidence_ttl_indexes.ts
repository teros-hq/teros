import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Drop TTL indexes on evidence collections.
 *
 * Product decision (Pablo, 2026-09-23): evidence collections never expire.
 * TTL is only legitimate on OPERATIONAL collections (machine state, not data).
 *
 * The 22-nov-2026 deadline: tool_executions / agent_usage_sessions / etc. with
 * a 180-day TTL would start auto-deleting ~1.6M docs silently. audit_logs was
 * already deleting (expireAt pattern, ~90d retention) — only 7.525 docs left.
 *
 * This migration drops the TTL index on each of the 12 evidence collections.
 * It does NOT touch operational TTLs (leader_locks, rate_limit_counters, etc.).
 *
 * Runtime ensureIndexes calls that recreated these TTLs have been neutralized
 * in the same change set — see audit-logger.ts, board-event-service.ts,
 * flow-webhook-service.ts, and agent-usage-projection-index-specs.ts.
 */

/** IndexNotFound error code — safe to ignore when dropping. */
const INDEX_NOT_FOUND = 27;
/** NamespaceNotFound — the collection doesn't exist (fresh DB). */
const NAMESPACE_NOT_FOUND = 26;

interface TtlDrop {
  collection: string;
  indexName: string;
}

const TTL_DROPS: readonly TtlDrop[] = [
  { collection: 'tool_executions', indexName: 'ttl_180d' },
  { collection: 'agent_usage_sessions', indexName: 'ttl_180d' },
  { collection: 'agent_usage_events', indexName: 'ttl_180d' },
  { collection: 'agent_usage_event_applications', indexName: 'ttl_180d' },
  { collection: 'agent_usage_rollup_runs', indexName: 'ttl_180d' },
  { collection: 'agent_usage_rollups_hourly', indexName: 'ttl_730d' },
  { collection: 'agent_usage_rollups_user_hourly', indexName: 'ttl_730d' },
  { collection: 'agent_usage_access_log', indexName: 'ttl_730d' },
  // Auto-generated index name (no explicit name was given at creation time)
  { collection: 'audit_logs', indexName: 'expireAt_1' },
  { collection: 'board_events', indexName: 'ttl_timestamp' },
  { collection: 'billing_webhook_events', indexName: 'billing_webhook_events_ttl' },
  // Auto-generated index name
  { collection: 'flow_webhook_invocations', indexName: 'timestamp_1' },
];

const migration: Migration = {
  description:
    'Drop TTL indexes on 12 evidence collections (product decision: evidence never expires)',

  async up(db: Db): Promise<void> {
    let dropped = 0;
    let skipped = 0;

    for (const { collection, indexName } of TTL_DROPS) {
      try {
        await db.collection(collection).dropIndex(indexName);
        console.log(`[Migration] Dropped TTL index ${indexName} from ${collection}`);
        dropped++;
      } catch (err) {
        const code = (err as { code?: number }).code;
        // 26 = NamespaceNotFound: on a fresh DB the collection doesn't exist yet
        // (migrations run before the central index registry, GOV-4).
        if (code === INDEX_NOT_FOUND || code === NAMESPACE_NOT_FOUND) {
          console.log(`[Migration] TTL index ${indexName} not found on ${collection} — skipping`);
          skipped++;
        } else {
          throw err;
        }
      }
    }

    console.log(
      `[Migration] Dropped ${dropped} TTL index(es), skipped ${skipped} (not found). ` +
        `Total processed: ${TTL_DROPS.length}.`,
    );
  },

  async down(db: Db): Promise<void> {
    // Re-creating the TTL indexes is intentionally NOT implemented.
    // The product decision is that evidence collections never expire.
    // If this decision is ever reversed, the original migrations
    // (20260519_001, 20260708_001, 20260708_003, 20260617_001, 20260814_001)
    // and the runtime ensureIndexes calls define the exact specs.
    console.log(
      '[Migration] down() is a no-op — re-creating evidence TTLs would contradict the product decision (evidence never expires).',
    );
  },
};

export default migration;
