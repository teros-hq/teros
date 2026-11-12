import type { Db } from 'mongodb';
import { encryptForUser } from '../auth/user-keys.js';
import type { Migration } from './types.js';

/**
 * Encrypt MFA TOTP secrets at rest (SEC-4).
 *
 * users.mfa.secret was stored in plaintext despite a comment saying
 * otherwise: anyone with database read access could generate valid codes.
 * Each secret is encrypted with its user's key (AAD mfa_totp) into
 * mfa.secretEnc. MFAService also encrypts any it reads.
 *
 * Needs the `encryption` system secret (loaded before migrations at boot).
 * Irreversible as written, so no down().
 */
const migration: Migration = {
  description: 'Encrypt plaintext MFA TOTP secrets with the user key',

  async up(db: Db): Promise<void> {
    const users = db.collection('users');
    let n = 0;
    for await (const user of users.find({ 'mfa.secret': { $type: 'string' } }, { projection: { userId: 1, mfa: 1 } })) {
      const secretEnc = await encryptForUser(db, user.userId as string, 'mfa_totp', user.mfa.secret);
      await users.updateOne(
        { _id: user._id, 'mfa.secret': user.mfa.secret },
        { $set: { 'mfa.secretEnc': secretEnc }, $unset: { 'mfa.secret': '' } },
      );
      n++;
    }
    console.log(`[Migration] Encrypted ${n} TOTP secret(s)`);
  },
};

export default migration;
