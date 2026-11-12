import type { Db } from 'mongodb';
import type { Migration } from './types.js';

const migration: Migration = {
  description: 'Add loadMode field to skills: existing skills set to always, new default is on-demand',

  async up(db: Db): Promise<void> {
    const skills = db.collection('skills');
    const result = await skills.updateMany(
      { loadMode: { $exists: false } },
      { $set: { loadMode: 'always' } },
    );
    console.log(`[Migration] Set loadMode='always' on ${result.modifiedCount} existing skills`);
  },

  async down(db: Db): Promise<void> {
    const skills = db.collection('skills');
    const result = await skills.updateMany(
      { loadMode: { $exists: true } },
      { $unset: { loadMode: '' } },
    );
    console.log(`[Migration] Removed loadMode from ${result.modifiedCount} skills`);
  },
};

export default migration;
