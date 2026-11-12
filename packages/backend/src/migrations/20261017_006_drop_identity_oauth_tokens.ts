import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Remove the OAuth provider tokens stored in plaintext on user_identities
 * (SEC-4). Sign-in never reads them back; IdentityService no longer writes
 * them. Irreversible by nature (the point is not to keep them), so no down().
 */
const migration: Migration = {
  description: 'Drop plaintext OAuth access/refresh tokens from user_identities',

  async up(db: Db): Promise<void> {
    const res = await db.collection('user_identities').updateMany(
      {
        $or: [
          { 'data.accessToken': { $exists: true } },
          { 'data.refreshToken': { $exists: true } },
          { 'data.tokenExpiresAt': { $exists: true } },
        ],
      },
      { $unset: { 'data.accessToken': '', 'data.refreshToken': '', 'data.tokenExpiresAt': '' } },
    );
    console.log(`[Migration] Removed OAuth tokens from ${res.modifiedCount} identit(ies)`);
  },
};

export default migration;
