/**
 * Migration: drop the `app_user_auth` collection (MUW v2.2, MUW-REQ-28).
 *
 * Per-user credentials for personal apps were written by the OAuth flow but
 * never read at execution time. Under the v2.2 model an app has one set of
 * credentials and one owner, so the collection, its service and its index go.
 *
 * Idempotent: dropping a missing collection is a no-op.
 *
 * @spec MUW-REQ-28
 */
import type { Db } from 'mongodb'
import type { Migration } from './types.js'

const migration: Migration = {
  description: 'MUW v2.2: drop app_user_auth (per-user app credentials are retired)',

  async up(db: Db): Promise<void> {
    const exists = (await db.listCollections({ name: 'app_user_auth' }).toArray()).length > 0
    if (!exists) {
      console.log('[20261102_003] app_user_auth does not exist — nothing to drop')
      return
    }
    const count = await db.collection('app_user_auth').countDocuments()
    await db.collection('app_user_auth').drop()
    console.log(`[20261102_003] dropped app_user_auth (${count} document(s))`)
  },
}

export default migration
