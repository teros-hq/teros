import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Pseudonymise users that were soft-deleted before account erasure existed
 * (GOV-3).
 *
 * The old UserService.deleteUser only set deletedAt, so those users kept
 * their real email and name. The unique profile.email index then blocked the
 * address from ever registering again (emailExists said "free", the insert
 * hit E11000), and the personal data stayed. They get the same tombstone
 * DeletionService.deleteUser writes: deleted+<userId>@deleted.invalid.
 *
 * Irreversible by nature (the original values are not kept), so no down().
 */
const migration: Migration = {
  description: 'Pseudonymise legacy soft-deleted users (free their email, drop name/avatar)',

  async up(db: Db): Promise<void> {
    const users = db.collection('users');
    const cursor = users.find(
      { deletedAt: { $exists: true }, 'profile.email': { $not: /@deleted\.invalid$/ } },
      { projection: { userId: 1 } },
    );
    let n = 0;
    for await (const user of cursor) {
      await users.updateOne(
        { _id: user._id },
        {
          $set: {
            'profile.email': `deleted+${user.userId}@deleted.invalid`,
            'profile.displayName': 'Deleted user',
          },
          $unset: { 'profile.avatarUrl': '', 'profile.description': '' },
        },
      );
      n++;
    }
    console.log(`[Migration] Pseudonymised ${n} legacy deleted user(s)`);
  },
};

export default migration;
