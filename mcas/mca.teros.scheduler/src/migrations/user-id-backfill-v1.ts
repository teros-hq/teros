/**
 * Migration `user_id_backfill_v1` (TER-358).
 *
 * Documentos pre-v1.1.0 en `scheduler_reminders`, `scheduler_recurring_tasks`
 * y `scheduler_executions` no tienen `user_id` (el schema no lo definía). Esta
 * migration backfilla el campo resolviendo el dueño del channel:
 *
 *   - `channels.findOne({_id: channel_id}).userId` → set `user_id` y opcional
 *     `workspace_id`.
 *   - Channel no existe / no tiene `userId` → set `user_id = '__orphaned__'`.
 *     Las queries normales del MCA excluyen este sentinel.
 *
 * Para `scheduler_executions` se mira el `task_id` y se resuelve via
 * `scheduler_recurring_tasks` (que ya tendrá `user_id` para entonces porque
 * la migration la procesa antes).
 *
 * **Idempotencia**: vía claim atómico en `scheduler_migrations`:
 *
 *   findOneAndUpdate(
 *     { _id: 'user_id_backfill_v1', completed_at: { $exists: false } },
 *     { $set: { started_at: Date.now() } },
 *     { upsert: true, returnDocument: 'before' }
 *   )
 *
 *   - Si `before` es null → upsert creó el doc, somos nosotros quien corre.
 *   - Si `before` existe con `completed_at`: ya completó, return.
 *   - Si `before` existe sin `completed_at`: otra réplica está corriendo
 *     (o murió). En el caso "murió" hay que recuperar — se documenta en
 *     follow-up: por ahora asumir abandono y retomar tras un timeout.
 *
 * Volumen Alpha es bajo (founding partners) — la migration debería tardar
 * <1s para colecciones de <10K docs. Para volúmenes mayores se paginaría.
 */

import type { ObjectId } from 'mongodb';
import { ORPHANED_USER_ID } from '@teros/shared';
import type { SchedulerDB } from '../db';

const MIGRATION_ID = 'user_id_backfill_v1';

/**
 * Si la migration lleva más de este tiempo "in flight" sin completar,
 * asumimos que el proceso anterior murió y la retomamos.
 */
const ABANDONED_AFTER_MS = 10 * 60 * 1000; // 10 minutos

interface ChannelDoc {
  _id: string;
  userId?: string;
  workspaceId?: string;
}

interface MigrationDoc {
  _id: string;
  started_at?: number;
  completed_at?: number;
  scanned?: number;
  backfilled?: number;
  orphaned?: number;
}

export async function backfillUserIdV1(db: SchedulerDB): Promise<void> {
  const migrations = db.migrations as unknown as import('mongodb').Collection<MigrationDoc>;

  // ---- Claim atómico ------------------------------------------------------
  // CAS real (no read-then-write): matchea solo si la migration está libre
  // (nunca arrancada) o abandonada (started_at viejo sin completed_at). El
  // upsert resuelve el caso "doc inexistente"; si otro container ya tiene el
  // doc (completado o en curso reciente) el filtro no matchea → el upsert
  // intenta insertar → E11000 → lo capturamos y salimos. Así solo UN container
  // entra a la sección de backfill (cierra el race read-then-write).
  const now = Date.now();
  try {
    await migrations.findOneAndUpdate(
      {
        _id: MIGRATION_ID,
        completed_at: { $exists: false },
        $or: [{ started_at: { $exists: false } }, { started_at: { $lt: now - ABANDONED_AFTER_MS } }],
      },
      { $set: { started_at: now }, $unset: { completed_at: '' } },
      { upsert: true, returnDocument: 'after' },
    );
  } catch (err) {
    // E11000: otro container ya posee el doc (completado o en curso) → no corremos.
    if ((err as { code?: number }).code === 11000) {
      console.error(
        `[Scheduler MCA] migration ${MIGRATION_ID} ya completada o en curso (otro container). Saltando.`,
      );
      return;
    }
    throw err;
  }

  // ---- Backfill recurring_tasks (antes que executions) --------------------
  let scanned = 0;
  let backfilled = 0;
  let orphaned = 0;
  const channels = db.channels as unknown as import('mongodb').Collection<ChannelDoc>;

  const taskCursor = db.recurringTasks.find({ user_id: { $exists: false } });
  for await (const task of taskCursor) {
    scanned++;
    const channel = await channels.findOne({ _id: task.channel_id });
    if (channel?.userId) {
      const update: Record<string, unknown> = { user_id: channel.userId };
      if (channel.workspaceId) update.workspace_id = channel.workspaceId;
      await db.recurringTasks.updateOne({ _id: task._id as ObjectId }, { $set: update });
      backfilled++;
    } else {
      await db.recurringTasks.updateOne(
        { _id: task._id as ObjectId },
        { $set: { user_id: ORPHANED_USER_ID } },
      );
      orphaned++;
    }
  }

  // ---- Backfill reminders -------------------------------------------------
  const reminderCursor = db.reminders.find({ user_id: { $exists: false } });
  for await (const reminder of reminderCursor) {
    scanned++;
    const channel = await channels.findOne({ _id: reminder.channel_id });
    if (channel?.userId) {
      const update: Record<string, unknown> = { user_id: channel.userId };
      if (channel.workspaceId) update.workspace_id = channel.workspaceId;
      await db.reminders.updateOne({ _id: reminder._id as ObjectId }, { $set: update });
      backfilled++;
    } else {
      await db.reminders.updateOne(
        { _id: reminder._id as ObjectId },
        { $set: { user_id: ORPHANED_USER_ID } },
      );
      orphaned++;
    }
  }

  // ---- Backfill executions -----------------------------------------------
  // El user_id de una execution = el de su task. PERO `task_id` (== el `id` de
  // la recurring task) es un counter PER-USER: dos usuarios pueden compartir el
  // mismo id. Una execution legacy solo guarda task_id+ran_at, sin forma fiable
  // de saber a qué usuario pertenece si el id está duplicado. Resolver por
  // `findOne({id})` atribuiría la execution al usuario equivocado (misma clase
  // que el bug cross-user). Por eso: si hay EXACTAMENTE una task con ese id la
  // usamos; si hay 0 o >1 (ambiguo) → ORPHANED, nunca una atribución errónea.
  const execCursor = db.executions.find({ user_id: { $exists: false } });
  for await (const exec of execCursor) {
    scanned++;
    const candidates = await db.recurringTasks
      .find({ id: exec.task_id }, { projection: { user_id: 1, _id: 0 } })
      .limit(2)
      .toArray();
    const userId =
      candidates.length === 1 && candidates[0].user_id
        ? candidates[0].user_id
        : ORPHANED_USER_ID;
    await db.executions.updateOne({ _id: exec._id as ObjectId }, { $set: { user_id: userId } });
    if (userId === ORPHANED_USER_ID) orphaned++;
    else backfilled++;
  }

  // ---- Marcar completado --------------------------------------------------
  await migrations.updateOne(
    { _id: MIGRATION_ID },
    { $set: { completed_at: Date.now(), scanned, backfilled, orphaned } },
  );
  console.error(
    `[Scheduler MCA] migration ${MIGRATION_ID} completed: scanned=${scanned} backfilled=${backfilled} orphaned=${orphaned}`,
  );
}
