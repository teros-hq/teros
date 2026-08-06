import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Index billing_invoices by (userId, status) for the transversal payment-due gate
 * (FASE 9, decision B).
 *
 * assertAccountNotBlocked runs at the provider choke point on EVERY turn, for
 * every provider (including BYOK), querying billing_invoices for an
 * 'uncollectible' / past-grace 'overdue' invoice for the user. Without this index
 * that per-turn lookup is a collection scan. (userId, status) also speeds the
 * admin panel's latest-invoice reads.
 */

const INDEX_NAME = 'billing_inv_user_status';

const migration: Migration = {
  description: 'Add {userId, status} index on billing_invoices for the payment-due gate',

  async up(db: Db): Promise<void> {
    const col = db.collection('billing_invoices');
    await col.createIndex({ userId: 1, status: 1 }, { name: INDEX_NAME });
    console.log(`[Migration] Created ${INDEX_NAME} index on billing_invoices`);
  },

  async down(db: Db): Promise<void> {
    const col = db.collection('billing_invoices');
    try {
      await col.dropIndex(INDEX_NAME);
      console.log(`[Migration] Dropped ${INDEX_NAME} index`);
    } catch (err) {
      if ((err as { code?: number }).code !== 27) throw err;
      console.log(`[Migration] ${INDEX_NAME} index did not exist, skipping`);
    }
  },
};

export default migration;
