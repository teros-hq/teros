/**
 * Migration: Add lastMessageAt field to existing channels.
 *
 * Sets lastMessageAt = updatedAt for all channels that don't have it yet.
 * Also creates the { lastMessageAt: -1, channelId: 1 } index for sort performance.
 *
 * Usage:
 *   npx tsx packages/backend/src/scripts/migrate-lastmessageat.ts
 *
 * Safe to run multiple times — idempotent.
 */
import { MongoClient } from 'mongodb';

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGO_DB || 'teros';

async function main() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db(DB_NAME);

  console.log(`[migrate-lastmessageat] Connected to ${MONGO_URL}/${DB_NAME}`);

  // 1. Backfill lastMessageAt = updatedAt for channels that don't have it
  const result = await db.collection('channels').updateMany(
    { lastMessageAt: { $exists: false } },
    [{ $set: { lastMessageAt: '$updatedAt' } }],
  );
  console.log(`[migrate-lastmessageat] Backfilled ${result.modifiedCount} channels (matched ${result.matchedCount})`);

  // 2. Create index for sort performance
  const indexName = await db.collection('channels').createIndex(
    { lastMessageAt: -1, channelId: 1 },
    { background: true },
  );
  console.log(`[migrate-lastmessageat] Index created: ${indexName}`);

  // 3. Verify
  const withLast = await db.collection('channels').countDocuments({ lastMessageAt: { $exists: true } });
  const total = await db.collection('channels').countDocuments({});
  console.log(`[migrate-lastmessageat] Verification: ${withLast}/${total} channels have lastMessageAt`);

  await client.close();
  console.log('[migrate-lastmessageat] Done');
}

main().catch((err) => {
  console.error('[migrate-lastmessageat] FATAL:', err);
  process.exit(1);
});
