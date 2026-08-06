import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Reverse-lookup index `llm_usage({ messageId: 1 })` (TER-616/F1, R4.4).
 *
 * The model-health window derives the thumbs-up/down rate per
 * `actualProvider×modelId` at query time (the feedback arrives too late for the
 * hourly rollup). The query joins `message_feedback.messageId` → `llm_usage`
 * to recover the upstream + model that produced the rated message; this index
 * makes that `$lookup` an index seek instead of a collection scan.
 *
 * Additive and non-destructive — the column already exists on every row.
 */
const migration: Migration = {
  description:
    'TER-616/F1: reverse-lookup index llm_usage.messageId for the model-health thumbs aggregation',

  async up(db: Db): Promise<void> {
    const col = db.collection('llm_usage');
    await col.createIndex({ messageId: 1 }, { name: 'messageId_lookup' });
    console.log('[Migration] Created index llm_usage.messageId_lookup');
  },

  async down(db: Db): Promise<void> {
    try {
      await db.collection('llm_usage').dropIndex('messageId_lookup');
      console.log('[Migration] Dropped llm_usage.messageId_lookup index');
    } catch (err) {
      // IndexNotFound (27) — already gone; ignore.
      if ((err as { code?: number }).code !== 27) {
        throw err;
      }
    }
  },
};

export default migration;
