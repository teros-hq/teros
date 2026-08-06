/**
 * Migration `drop_legacy_global_id_index_v1` (TER-387).
 *
 * Antes de TER-358 el scheduler usaba un counter de ids **global** y un índice
 * unique **global** sobre solo `{ id: 1 }` (MongoDB lo nombra `id_1`). TER-358
 * (PR #109) cambió a counters **per-user** que reinician en 1 y a un índice
 * unique **compuesto** `{ id: 1, user_id: 1 }`, pero `createIndex` es aditivo y
 * **nunca dropeó el índice global viejo**. En bases creadas con la versión
 * antigua (producción) el índice `id_1` sobrevive: con counters per-user, dos
 * usuarios distintos generan legítimamente `id: 1`, lo que viola el índice
 * global → `E11000 duplicate key error ... index: id_1 dup key: { id: 1 }`.
 *
 * Esta migration elimina cualquier índice unique cuya key sea **exactamente**
 * `{ id: 1 }` en `scheduler_reminders` y `scheduler_recurring_tasks`. El índice
 * compuesto correcto `{ id: 1, user_id: 1 }` (2 campos) NO se toca.
 *
 * **Idempotencia**: el drop solo ocurre si el índice existe; `IndexNotFound`
 * se ignora (carrera entre containers). Es barata (un `listIndexes` por
 * colección), así que corre en cada `connect()` sin gate — garantiza que el
 * índice legacy nunca sobreviva aunque reaparezca. Deja registro en
 * `scheduler_migrations` para trazabilidad.
 */

import type { Collection } from 'mongodb';
import type { SchedulerDB } from '../db';

const MIGRATION_ID = 'drop_legacy_global_id_index_v1';

/** MongoDB error code/name para "índice no encontrado". */
const INDEX_NOT_FOUND_CODE = 27;
const INDEX_NOT_FOUND_NAME = 'IndexNotFound';

interface MigrationDoc {
  _id: string;
  last_run_at?: number;
  dropped?: string[];
}

/**
 * ¿Es un índice unique global sobre solo `{ id: 1 }`? Filtramos por la SHAPE de
 * la key (no por el nombre `id_1`) para capturarlo aunque tenga un nombre
 * distinto. El índice compuesto `{ id: 1, user_id: 1 }` tiene 2 campos → se
 * excluye. El índice `_id_` por defecto tiene key `{ _id: 1 }` → se excluye.
 */
export function isLegacyGlobalIdIndex(index: { key: Record<string, unknown>; unique?: boolean }): boolean {
  const keys = Object.keys(index.key);
  return keys.length === 1 && index.key.id === 1 && index.unique === true;
}

async function dropLegacyIndexes(coll: Collection<any>): Promise<string[]> {
  const dropped: string[] = [];
  const indexes = await coll.listIndexes().toArray();
  for (const index of indexes) {
    if (!isLegacyGlobalIdIndex(index)) continue;
    try {
      await coll.dropIndex(index.name);
      dropped.push(`${coll.collectionName}.${index.name}`);
    } catch (err: any) {
      // Otro container lo dropeó primero — idempotente, seguimos.
      if (err?.code !== INDEX_NOT_FOUND_CODE && err?.codeName !== INDEX_NOT_FOUND_NAME) {
        throw err;
      }
    }
  }
  return dropped;
}

export async function dropLegacyGlobalIdIndexV1(db: SchedulerDB): Promise<void> {
  const dropped = [
    ...(await dropLegacyIndexes(db.reminders)),
    ...(await dropLegacyIndexes(db.recurringTasks)),
  ];

  if (dropped.length === 0) return;

  const migrations = db.migrations as unknown as import('mongodb').Collection<MigrationDoc>;
  await migrations.updateOne(
    { _id: MIGRATION_ID },
    { $set: { last_run_at: Date.now(), dropped } },
    { upsert: true },
  );
  console.error(
    `[Scheduler MCA] migration ${MIGRATION_ID}: dropped legacy unique index(es) ${dropped.join(', ')}`,
  );
}
