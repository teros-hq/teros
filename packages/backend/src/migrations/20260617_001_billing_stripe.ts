import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Stripe payment rail (FASE 4, Model B — Teros stays source of truth).
 *
 * Brand-new collections (no backfill of existing data needed):
 *   1. billing_customers      — per-user Stripe customer mapping. _id = userId
 *      (PK), plus a unique index on stripeCustomerId so two users can never
 *      share a Stripe customer.
 *   2. billing_webhook_events — dedup ledger for incoming Stripe webhooks. _id =
 *      Stripe event id (PK) makes reprocessing a delivered event a no-op
 *      (insert fails with E11000). A TTL on receivedAt prunes old records.
 *
 * The invoice dunning fields (attemptCount/nextAttemptAt/gracePeriodEndsAt/…)
 * are optional and absent on legacy invoices — no backfill required; the
 * charge-cron treats "absent" as "attempt now, no failures yet".
 */

const CUSTOMER_INDEX = 'billing_customer_stripeId_unique';
const WEBHOOK_TTL_INDEX = 'billing_webhook_events_ttl';
/** Webhook dedup records are retained this long, then TTL-pruned. */
const WEBHOOK_TTL_SECONDS = 30 * 24 * 60 * 60;

const migration: Migration = {
  description: 'Stripe payment rail: billing_customers + billing_webhook_events indexes',

  async up(db: Db): Promise<void> {
    const customers = db.collection('billing_customers');
    await customers.createIndex(
      { stripeCustomerId: 1 },
      { unique: true, name: CUSTOMER_INDEX },
    );
    console.log(`[Migration] Created ${CUSTOMER_INDEX} on billing_customers`);

    const events = db.collection('billing_webhook_events');
    await events.createIndex(
      { receivedAt: 1 },
      { name: WEBHOOK_TTL_INDEX, expireAfterSeconds: WEBHOOK_TTL_SECONDS },
    );
    console.log(`[Migration] Created ${WEBHOOK_TTL_INDEX} TTL on billing_webhook_events`);
  },

  async down(db: Db): Promise<void> {
    for (const [coll, index] of [
      ['billing_customers', CUSTOMER_INDEX],
      ['billing_webhook_events', WEBHOOK_TTL_INDEX],
    ] as const) {
      try {
        await db.collection(coll).dropIndex(index);
        console.log(`[Migration] Dropped ${index} from ${coll}`);
      } catch (err) {
        // 27 = IndexNotFound — safe to ignore on rollback.
        if ((err as { code?: number }).code !== 27) throw err;
        console.log(`[Migration] ${index} did not exist, skipping`);
      }
    }
  },
};

export default migration;
