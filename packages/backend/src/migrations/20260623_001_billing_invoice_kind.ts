import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Invoice `kind` discriminator + partial period-unique index (TER-596 I1).
 *
 * billing.purchase-boost writes a one-off boost invoice that copies the active
 * subscription period. The old billing_inv_period_unique index was a FULL unique
 * on (subscriptionId, periodStart, periodEnd), so a second boost in the same
 * period — or a boost plus the reset-cron's period invoice — collided with E11000
 * AFTER the card was charged (money taken, boost not granted, no self-heal).
 *
 * Fix: tag every invoice with kind ('subscription' | 'boost') and make the
 * period-unique index PARTIAL on kind:'subscription'. Boost invoices are keyed by
 * their own _id (= purchaseId) and are no longer constrained by the period index.
 *
 * Backfills existing rows to kind:'subscription' (every invoice predating this
 * change is a reset-cron period invoice). ensureBillingIndexes recreates the
 * same partial index at boot too; this migration keeps the schema self-contained.
 */

const PERIOD_INDEX = 'billing_inv_period_unique';

async function dropIfExists(db: Db, collection: string, index: string): Promise<void> {
  try {
    await db.collection(collection).dropIndex(index);
    console.log(`[Migration] Dropped ${index} from ${collection}`);
  } catch (err) {
    // 27 = IndexNotFound; 26 = NamespaceNotFound (collection never created).
    const code = (err as { code?: number }).code;
    if (code !== 27 && code !== 26) throw err;
    console.log(`[Migration] ${index} did not exist on ${collection}, skipping`);
  }
}

const migration: Migration = {
  description: 'Invoice kind discriminator + partial period-unique index',

  async up(db: Db): Promise<void> {
    const invoices = db.collection('billing_invoices');

    // 1. Backfill: every pre-existing invoice is a subscription/period invoice
    //    (boost purchase is new in this stack). Must run BEFORE the partial index
    //    so existing period invoices are covered by it.
    const res = await invoices.updateMany(
      { kind: { $exists: false } },
      { $set: { kind: 'subscription' } },
    );
    console.log(`[Migration] Backfilled kind:'subscription' on ${res.modifiedCount} invoices`);

    // 2. Recreate the period-unique index as PARTIAL on kind:'subscription'.
    //    Idempotent: if ensureBillingIndexes already made it partial at boot, the
    //    drop + recreate yields the same spec.
    await dropIfExists(db, 'billing_invoices', PERIOD_INDEX);
    await invoices.createIndex(
      { subscriptionId: 1, periodStart: 1, periodEnd: 1 },
      {
        name: PERIOD_INDEX,
        unique: true,
        partialFilterExpression: { kind: 'subscription' },
      },
    );
    console.log('[Migration] Recreated billing_inv_period_unique as partial (kind:subscription)');
  },

  async down(db: Db): Promise<void> {
    const invoices = db.collection('billing_invoices');
    await dropIfExists(db, 'billing_invoices', PERIOD_INDEX);
    await invoices.updateMany({}, { $unset: { kind: '' } });
    // Best-effort revert to the full-unique index. NOTE: this fails if any boost
    // invoices share a period with another invoice — that collision is exactly
    // what the forward migration fixed, so a clean down requires removing boost
    // invoices first.
    await invoices.createIndex(
      { subscriptionId: 1, periodStart: 1, periodEnd: 1 },
      { name: PERIOD_INDEX, unique: true },
    );
  },
};

export default migration;
