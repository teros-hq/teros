import type { Db } from 'mongodb';
import type { Migration } from './types.js';

const migration: Migration = {
  description:
    'Autoplay v2: backfill slots=0 and playEnabled=false on all existing agent_project_relationships. ' +
    'Also removes the legacy "role" field.',

  async up(db: Db): Promise<void> {
    const col = db.collection('agent_project_relationships');

    // Backfill slots and playEnabled on all existing records
    const result = await col.updateMany(
      { slots: { $exists: false } },
      {
        $set: { slots: 0, playEnabled: false },
        $unset: { role: '' },
      },
    );

    console.log(
      `[Migration] autoplay_v2: updated ${result.modifiedCount} agent_project_relationships with slots=0, playEnabled=false`,
    );

    // Ensure compound unique index
    await col.createIndex({ projectId: 1, agentId: 1 }, { unique: true });
    await col.createIndex({ projectId: 1, playEnabled: 1 });

    console.log('[Migration] autoplay_v2: indexes created on agent_project_relationships');
  },

  async down(db: Db): Promise<void> {
    const col = db.collection('agent_project_relationships');

    // Restore role field and remove new fields
    await col.updateMany(
      {},
      {
        $set: { role: 'runner' },
        $unset: { slots: '', playEnabled: '' },
      },
    );

    console.log('[Migration] autoplay_v2 rollback: restored role field, removed slots/playEnabled');
  },
};

export default migration;
