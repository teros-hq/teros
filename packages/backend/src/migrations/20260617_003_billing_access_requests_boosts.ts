import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Request-access flow + per-period hour boosts (FASE 6).
 *
 * Two brand-new collections:
 *   - billing_access_requests: a partial unique index on (userId, type) where
 *     status:'pending' caps a blocked user to one pending request per type, so
 *     the request-access widget cannot spam the admin queue.
 *   - billing_hour_boosts: a unique index on accessRequestId makes approving the
 *     same request twice unable to mint a second boost (idempotent approval).
 */

const ACCESS_PENDING_INDEX = 'billing_access_req_one_pending';
const ACCESS_STATUS_INDEX = 'billing_access_req_status';
const ACCESS_USER_INDEX = 'billing_access_req_userId';
const BOOST_REQUEST_INDEX = 'billing_boost_request_unique';
const BOOST_SUB_STATUS_INDEX = 'billing_boost_sub_status';
const BOOST_USER_INDEX = 'billing_boost_userId';

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
  description: 'Billing access requests + per-period hour boosts (indexes)',

  async up(db: Db): Promise<void> {
    const accessReq = db.collection('billing_access_requests');
    await accessReq.createIndex(
      { userId: 1, type: 1 },
      {
        name: ACCESS_PENDING_INDEX,
        unique: true,
        partialFilterExpression: { status: 'pending' },
      },
    );
    await accessReq.createIndex({ status: 1 }, { name: ACCESS_STATUS_INDEX });
    await accessReq.createIndex({ userId: 1 }, { name: ACCESS_USER_INDEX });

    const boosts = db.collection('billing_hour_boosts');
    // PARTIAL-unique on accessRequestId, aligned with ensureBillingIndexes (which
    // runs at boot BEFORE migrations and already creates this partial). A
    // non-partial spec here would collide (IndexOptionsConflict, code 85) with the
    // partial index on a fresh DB and abort startup. The partial filter also lets
    // purchase boosts (accessRequestId: null) coexist (TER-596 I1).
    await boosts.createIndex(
      { accessRequestId: 1 },
      {
        name: BOOST_REQUEST_INDEX,
        unique: true,
        partialFilterExpression: { accessRequestId: { $type: 'string' } },
      },
    );
    await boosts.createIndex(
      { subscriptionId: 1, status: 1 },
      { name: BOOST_SUB_STATUS_INDEX },
    );
    await boosts.createIndex({ userId: 1 }, { name: BOOST_USER_INDEX });

    console.log('[Migration] Created indexes for billing_access_requests + billing_hour_boosts');
  },

  async down(db: Db): Promise<void> {
    await dropIfExists(db, 'billing_access_requests', ACCESS_PENDING_INDEX);
    await dropIfExists(db, 'billing_access_requests', ACCESS_STATUS_INDEX);
    await dropIfExists(db, 'billing_access_requests', ACCESS_USER_INDEX);
    await dropIfExists(db, 'billing_hour_boosts', BOOST_REQUEST_INDEX);
    await dropIfExists(db, 'billing_hour_boosts', BOOST_SUB_STATUS_INDEX);
    await dropIfExists(db, 'billing_hour_boosts', BOOST_USER_INDEX);
  },
};

export default migration;
