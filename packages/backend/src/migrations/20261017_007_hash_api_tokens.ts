import { createHash, randomBytes } from 'crypto';
import type { Db } from 'mongodb';
import { dropIndexIfExists, ensureIndex } from './helpers.js';
import type { Migration } from './types.js';

/**
 * Store API tokens hashed (SEC-4).
 *
 * api_tokens kept the raw token: readable by anyone with database read
 * access, returned by the list endpoint. Each token gets tokenHash (sha256),
 * a public tokenId and a display tokenPrefix; the raw value is removed.
 * Existing tokens keep working (clients send the raw token, it is hashed on
 * lookup) and get no expiry; new ones expire after a year.
 *
 * Irreversible by nature (the raw tokens are not kept), so no down().
 */
const migration: Migration = {
  description: 'Hash api_tokens (tokenHash + tokenId + tokenPrefix), drop the plaintext token',

  async up(db: Db): Promise<void> {
    const tokens = db.collection('api_tokens');
    // Unique lookups first, so the backfill below can't create duplicates
    await ensureIndex(
      db,
      'api_tokens',
      { tokenHash: 1 },
      { name: 'tokenHash_unique', unique: true, partialFilterExpression: { tokenHash: { $type: 'string' } } },
    );
    await ensureIndex(
      db,
      'api_tokens',
      { tokenId: 1 },
      { name: 'tokenId_unique', unique: true, partialFilterExpression: { tokenId: { $type: 'string' } } },
    );
    await ensureIndex(db, 'api_tokens', { userId: 1 }, { name: 'userId_1' });
    // The old unique index on the plaintext field (created by g2-routes) has
    // to go before the backfill: it is not sparse, so the second document
    // whose token gets unset would collide on { token: null } (E11000) and
    // leave the migration half-applied. tokenHash_unique above already
    // guards uniqueness from here on.
    await dropIndexIfExists(db, 'api_tokens', 'token_1');

    let n = 0;
    for await (const doc of tokens.find({ token: { $type: 'string' } }, { projection: { token: 1 } })) {
      const raw = doc.token as string;
      await tokens.updateOne(
        { _id: doc._id },
        {
          $set: {
            tokenHash: createHash('sha256').update(raw).digest('hex'),
            tokenId: `atok_${randomBytes(8).toString('hex')}`,
            tokenPrefix: raw.slice(0, 12),
          },
          $unset: { token: '' },
        },
      );
      n++;
    }
    console.log(`[Migration] Hashed ${n} API token(s)`);
  },
};

export default migration;
