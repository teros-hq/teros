import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Billing audit trail (FASE 2a/2b).
 *
 * Creates the two append-only collections that make every invoice explainable:
 *   - billing_hour_ledger:     one entry per tracker commit into agentHoursUsed.
 *   - billing_period_snapshots: consumption captured at each period close.
 *
 * Both are new collections (no existing data to migrate), so this migration
 * only creates the structural guards — the unique indexes that make a duplicate
 * ledger entry or period snapshot impossible by construction. ensureBillingIndexes
 * creates the same indexes at startup; createIndex is idempotent when the spec
 * matches, so the two paths coexist.
 */

const LEDGER_UNIQUE = 'billing_ledger_sub_bucket_unique';
const SNAPSHOT_UNIQUE = 'billing_snapshot_period_unique';

const migration: Migration = {
  description:
    'Create billing_hour_ledger + billing_period_snapshots unique indexes (audit trail)',

  async up(db: Db): Promise<void> {
    const ledger = db.collection('billing_hour_ledger');
    await ledger.createIndex(
      { subscriptionId: 1, hourBucket: 1 },
      { unique: true, name: LEDGER_UNIQUE },
    );
    await ledger.createIndex({ userId: 1 }, { name: 'billing_ledger_userId' });
    await ledger.createIndex({ trackerRunId: 1 }, { name: 'billing_ledger_runId' });
    console.log(`[Migration] Created ${LEDGER_UNIQUE} (+ userId, runId) on billing_hour_ledger`);

    const snapshots = db.collection('billing_period_snapshots');
    await snapshots.createIndex(
      { subscriptionId: 1, periodStart: 1, periodEnd: 1 },
      { unique: true, name: SNAPSHOT_UNIQUE },
    );
    await snapshots.createIndex({ userId: 1 }, { name: 'billing_snapshot_userId' });
    console.log(`[Migration] Created ${SNAPSHOT_UNIQUE} (+ userId) on billing_period_snapshots`);
  },

  async down(db: Db): Promise<void> {
    for (const [name, index] of [
      ['billing_hour_ledger', LEDGER_UNIQUE],
      ['billing_period_snapshots', SNAPSHOT_UNIQUE],
    ] as const) {
      try {
        await db.collection(name).dropIndex(index);
        console.log(`[Migration] Dropped ${index}`);
      } catch (err) {
        if ((err as { code?: number }).code !== 27) throw err;
        console.log(`[Migration] ${index} did not exist, skipping`);
      }
    }
  },
};

export default migration;
