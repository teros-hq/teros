import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Pin `mca.teros.core` installs to `toolExposure: 'direct'`.
 *
 * With the `tools.execution-proxy` flag ON every app is proxied by default —
 * the agent's tool list is just the three meta-tools and everything else is
 * discovered on demand. Core platform tools (messages, tasks, agent
 * management) are used on nearly every turn, so routing them through the
 * discovery round-trip would tax every conversation. This pins existing core
 * installs to the per-app 'direct' opt-out; `createApp` seeds the same pin
 * for new installs.
 *
 * Explicit pins are never overwritten (there are none before this migration,
 * but the guard keeps re-runs and operator edits safe). `down` unpins only
 * core apps whose value matches what `up` wrote.
 */
const migration: Migration = {
  description:
    "Pin toolExposure='direct' on mca.teros.core installs so core tools skip the tool-execution proxy",

  async up(db: Db): Promise<void> {
    const result = await db.collection('apps').updateMany(
      { mcaId: 'mca.teros.core', toolExposure: { $exists: false } },
      { $set: { toolExposure: 'direct', updatedAt: new Date().toISOString() } },
    );
    console.log(
      `[20260704_003] Pinned toolExposure='direct' on ${result.modifiedCount} mca.teros.core apps`,
    );
  },

  async down(db: Db): Promise<void> {
    const result = await db.collection('apps').updateMany(
      { mcaId: 'mca.teros.core', toolExposure: 'direct' },
      { $unset: { toolExposure: '' }, $set: { updatedAt: new Date().toISOString() } },
    );
    console.log(
      `[20260704_003] Unpinned toolExposure on ${result.modifiedCount} mca.teros.core apps`,
    );
  },
};

export default migration;
