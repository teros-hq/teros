import type { Db } from 'mongodb';
import { AAD_FORMAT, encryptForUser } from '../auth/user-keys.js';
import type { Migration } from './types.js';

/**
 * Encrypt personal-app OAuth credentials at rest (SEC-4).
 *
 * app_user_auth.auth held each user's OAuth tokens in plaintext. Each record
 * is encrypted with its user's key (AAD app_user_auth:<appId>) into `enc`,
 * and the plaintext removed. AppUserAuthService also encrypts any record it
 * reads, so a record missed here is fixed on first use.
 *
 * Needs the `encryption` system secret (loaded before migrations at boot).
 * Irreversible as written (the plaintext is dropped), so no down().
 */
const migration: Migration = {
  description: 'Encrypt app_user_auth OAuth credentials with the user key',

  async up(db: Db): Promise<void> {
    const col = db.collection('app_user_auth');
    let n = 0;
    for await (const doc of col.find({ auth: { $exists: true }, enc: { $exists: false } })) {
      const enc = await encryptForUser(db, doc.userId as string, `app_user_auth:${doc.appId}`, doc.auth);
      await col.updateOne(
        { _id: doc._id, enc: { $exists: false } },
        { $set: { enc, encryptionFormat: AAD_FORMAT }, $unset: { auth: '' }, $inc: { rev: 1 } },
      );
      n++;
    }
    console.log(`[Migration] Encrypted ${n} app_user_auth record(s)`);
  },
};

export default migration;
