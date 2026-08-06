/**
 * Regression test — `drop_legacy_global_id_index_v1` (TER-387).
 *
 * Reproduce el bug de producción: una base creada antes de TER-358 conserva un
 * índice unique GLOBAL sobre solo `{ id: 1 }` (nombre `id_1`). Con counters
 * per-user que reinician en 1, dos usuarios distintos generan `id: 1`, lo que
 * viola ese índice → `E11000 ... index: id_1 dup key: { id: 1 }`.
 *
 * Verifica que la migración:
 *   - Detecta el índice legacy por la SHAPE de la key (no por el nombre).
 *   - Lo dropea, dejando intacto el índice compuesto `{ id: 1, user_id: 1 }`.
 *   - Tras dropear, dos usuarios pueden insertar `id: 1` sin E11000.
 *   - Es idempotente (re-correr no falla).
 *
 * El test unitario de `isLegacyGlobalIdIndex` corre sin Mongo; el de
 * integración usa la DB local (como `migration.test.ts`) con sentinels.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  dropLegacyGlobalIdIndexV1,
  isLegacyGlobalIdIndex,
} from '../src/migrations/drop-legacy-global-id-index-v1';
import { SchedulerDB } from '../src/db';

describe('isLegacyGlobalIdIndex (puro)', () => {
  it('detecta el índice unique global sobre solo { id: 1 }', () => {
    expect(isLegacyGlobalIdIndex({ key: { id: 1 }, unique: true })).toBe(true);
  });

  it('NO toca el índice compuesto { id: 1, user_id: 1 }', () => {
    expect(isLegacyGlobalIdIndex({ key: { id: 1, user_id: 1 }, unique: true })).toBe(false);
  });

  it('NO toca el índice por defecto { _id: 1 }', () => {
    expect(isLegacyGlobalIdIndex({ key: { _id: 1 }, unique: true })).toBe(false);
  });

  it('NO toca un índice { id: 1 } NO unique', () => {
    expect(isLegacyGlobalIdIndex({ key: { id: 1 } })).toBe(false);
    expect(isLegacyGlobalIdIndex({ key: { id: 1 }, unique: false })).toBe(false);
  });
});

// ── Integración (requiere Mongo local, igual que migration.test.ts) ──────────

const LEGACY_INDEX_NAME = 'id_1';
const USER_A = 'user_droptest_aaaaaa';
const USER_B = 'user_droptest_bbbbbb';
const TEST_TAG_IDS = [1, 2]; // ids per-user que colisionan globalmente
const MIGRATION_ID = 'drop_legacy_global_id_index_v1';

const db = new SchedulerDB();

/** Borra los docs sembrados por este test (acotado a nuestros users). */
async function cleanupSeed(): Promise<void> {
  await db.reminders.deleteMany({ user_id: { $in: [USER_A, USER_B] } });
  await db.recurringTasks.deleteMany({ user_id: { $in: [USER_A, USER_B] } });
}

/** Asegura que el índice legacy no existe (estado base conocido). */
async function dropLegacyIfPresent(): Promise<void> {
  for (const coll of [db.reminders, db.recurringTasks]) {
    try {
      await coll.dropIndex(LEGACY_INDEX_NAME);
    } catch {
      /* no existía — ok */
    }
  }
}

beforeEach(async () => {
  if (!db.isConnected()) await db.connect();
  await cleanupSeed();
  await dropLegacyIfPresent();
  await db.migrations.deleteOne({ _id: MIGRATION_ID });
});

afterAll(async () => {
  await cleanupSeed();
  await dropLegacyIfPresent();
  await db.close();
});

describe('drop_legacy_global_id_index_v1 (integración)', () => {
  it('dropea el índice legacy y deja el compuesto intacto', async () => {
    await db.reminders.createIndex({ id: 1 }, { unique: true, sparse: true, name: LEGACY_INDEX_NAME });

    await dropLegacyGlobalIdIndexV1(db);

    const indexes = await db.reminders.listIndexes().toArray();
    const names = indexes.map((i) => i.name);
    expect(names).not.toContain(LEGACY_INDEX_NAME);
    // El compuesto correcto sigue presente (lo crea init() en connect()).
    expect(names).toContain('id_1_user_id_1');
  });

  it('tras el drop, dos usuarios pueden tener id=1 sin E11000', async () => {
    await db.recurringTasks.createIndex(
      { id: 1 },
      { unique: true, sparse: true, name: LEGACY_INDEX_NAME },
    );
    // Con el índice legacy presente, el segundo insert de id=1 falla.
    await db.recurringTasks.insertOne({ id: 1, user_id: USER_A, channel_id: 'ch_a' } as any);
    await expect(
      db.recurringTasks.insertOne({ id: 1, user_id: USER_B, channel_id: 'ch_b' } as any),
    ).rejects.toThrow(/E11000|duplicate key/);

    // Limpiamos el doc de A para repetir el insert tras el fix.
    await db.recurringTasks.deleteMany({ user_id: { $in: [USER_A, USER_B] } });

    await dropLegacyGlobalIdIndexV1(db);

    // Ahora ambos usuarios conviven con id=1 (unicidad solo per-user).
    await db.recurringTasks.insertOne({ id: 1, user_id: USER_A, channel_id: 'ch_a' } as any);
    await db.recurringTasks.insertOne({ id: 1, user_id: USER_B, channel_id: 'ch_b' } as any);
    const count = await db.recurringTasks.countDocuments({ id: 1, user_id: { $in: [USER_A, USER_B] } });
    expect(count).toBe(2);
  });

  it('es idempotente — re-correr sin índice legacy no falla', async () => {
    await dropLegacyGlobalIdIndexV1(db); // sin legacy presente
    await dropLegacyGlobalIdIndexV1(db); // segunda corrida
    const indexes = await db.reminders.listIndexes().toArray();
    expect(indexes.map((i) => i.name)).not.toContain(LEGACY_INDEX_NAME);
  });
});
