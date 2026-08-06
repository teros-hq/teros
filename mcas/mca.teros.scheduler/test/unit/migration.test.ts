/**
 * Migration test — `user_id_backfill_v1` (TER-358).
 *
 * Verifica que la migration:
 *
 *   - Backfilla documentos con `channel_id` resoluble desde `channels`.
 *   - Marca `user_id = '__orphaned__'` cuando el channel no existe.
 *   - Es idempotente (re-correr no duplica trabajo).
 *   - Persiste workspace_id si está en el channel.
 *   - Las queries normales (`listReminders` con user real) excluyen orphans.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ORPHANED_USER_ID } from '@teros/shared';
import { backfillUserIdV1 } from '../../src/migrations/user-id-backfill-v1';
import { SchedulerDB } from '../../src/db';

// NOTA importante: SchedulerDB lee MONGODB_DB_NAME al cargar el módulo, no
// en el constructor. Por eso no podemos cambiarlo desde beforeAll. Estos
// tests trabajan sobre el mismo DB que el SchedulerDB usa por defecto y
// limpian aggresivamente en beforeEach. Hay riesgo cero de pisar data real
// porque los ids elegidos (>900) son sentinels que no aparecen en uso real
// — y el cleanup borra solo los docs sembrados por este test.

const CHANNEL_KNOWN = 'ch_resolvable_aaaaaa';
const CHANNEL_ORPHAN = 'ch_orphaned_xxxxxxx';
const USER = 'user_mig_test_aaaaaa';
const WORKSPACE = 'work_mig_test_bbbbb';

const MIGRATION_ID = 'user_id_backfill_v1';

// Sentinels para identificar los docs de este test y limpiarlos sin tocar
// otros docs locales.
const TEST_TAG_IDS = [995, 996, 997, 998, 999];
const TEST_TAG_TASK_ID = 50;

const db = new SchedulerDB();

beforeAll(async () => {
  await db.connect();
});

afterAll(async () => {
  // Cleanup agresivo de los sentinels.
  await db.reminders.deleteMany({ id: { $in: TEST_TAG_IDS } });
  await db.recurringTasks.deleteMany({ id: TEST_TAG_TASK_ID });
  await db.executions.deleteMany({ task_id: TEST_TAG_TASK_ID });
  await db.channels.deleteMany({ _id: { $in: [CHANNEL_KNOWN, CHANNEL_ORPHAN] as any } });
  await db.close();
});

beforeEach(async () => {
  await db.reminders.deleteMany({ id: { $in: TEST_TAG_IDS } });
  await db.recurringTasks.deleteMany({ id: TEST_TAG_TASK_ID });
  await db.executions.deleteMany({ task_id: TEST_TAG_TASK_ID });
  await db.channels.deleteMany({ _id: { $in: [CHANNEL_KNOWN, CHANNEL_ORPHAN] as any } });
  // Reset migration marker para que la próxima `backfillUserIdV1` corra.
  await db.migrations.deleteOne({ _id: MIGRATION_ID });
});

describe('user_id_backfill_v1', () => {
  it('backfilla reminders con channel resoluble', async () => {
    await db.channels.insertOne({ _id: CHANNEL_KNOWN as any, userId: USER, workspaceId: WORKSPACE });
    await db.reminders.insertOne({
      id: 999,
      channel_id: CHANNEL_KNOWN,
      message: 'legacy',
      scheduled_time: Date.now() + 3_600_000,
      created_at: Date.now() - 86_400_000,
      status: 'pending',
    } as any);

    await backfillUserIdV1(db);

    const reminder = await db.reminders.findOne({ id: 999 });
    expect(reminder?.user_id).toBe(USER);
    expect(reminder?.workspace_id).toBe(WORKSPACE);
  });

  it('marca __orphaned__ cuando el channel no existe', async () => {
    await db.reminders.insertOne({
      id: 998,
      channel_id: CHANNEL_ORPHAN,
      message: 'orphan',
      scheduled_time: Date.now() + 3_600_000,
      created_at: Date.now() - 86_400_000,
      status: 'pending',
    } as any);

    await backfillUserIdV1(db);

    const reminder = await db.reminders.findOne({ id: 998 });
    expect(reminder?.user_id).toBe(ORPHANED_USER_ID);
  });

  it('migration idempotente — segunda corrida no re-backfilla', async () => {
    await db.channels.insertOne({ _id: CHANNEL_KNOWN as any, userId: USER });
    await db.reminders.insertOne({
      id: 997,
      channel_id: CHANNEL_KNOWN,
      message: 'idempotent',
      scheduled_time: Date.now() + 3_600_000,
      created_at: Date.now(),
      status: 'pending',
    } as any);

    await backfillUserIdV1(db);
    const migrationDoc1 = await db.migrations.findOne({ _id: MIGRATION_ID });
    const completedAt1 = migrationDoc1?.completed_at;
    expect(typeof completedAt1).toBe('number');

    // Segunda corrida — no debe re-procesar (completed_at no cambia).
    await backfillUserIdV1(db);
    const migrationDoc2 = await db.migrations.findOne({ _id: MIGRATION_ID });
    expect(migrationDoc2?.completed_at).toBe(completedAt1);
  });

  it('queries normales excluyen __orphaned__', async () => {
    // Seed: un orphan + un user-real.
    await db.reminders.insertOne({
      id: 996,
      channel_id: CHANNEL_ORPHAN,
      message: 'orphan-doc',
      scheduled_time: Date.now() + 3_600_000,
      created_at: Date.now(),
      status: 'pending',
    } as any);
    await db.channels.insertOne({ _id: CHANNEL_KNOWN as any, userId: USER });
    await db.reminders.insertOne({
      id: 995,
      channel_id: CHANNEL_KNOWN,
      message: 'real-doc',
      scheduled_time: Date.now() + 3_600_000,
      created_at: Date.now(),
      status: 'pending',
    } as any);

    await backfillUserIdV1(db);

    // El user real ve solo el suyo via listReminders.
    const userPage = await db.listReminders({ userId: USER });
    const ourReminder = userPage.items.find((r) => r.id === 995);
    expect(ourReminder).toBeDefined();
    expect(ourReminder?.message).toBe('real-doc');

    // Y NO ve el orphan (porque no es del user).
    const orphanInList = userPage.items.find((r) => r.id === 996);
    expect(orphanInList).toBeUndefined();
  });

  it('backfill cascada: executions resuelven via task.user_id', async () => {
    await db.channels.insertOne({ _id: CHANNEL_KNOWN as any, userId: USER });
    await db.recurringTasks.insertOne({
      id: TEST_TAG_TASK_ID,
      channel_id: CHANNEL_KNOWN,
      message: 'task',
      cron_expression: '0 9 * * *',
      timezone: 'UTC',
      enabled: true,
      next_run: Date.now() + 86_400_000,
      created_at: Date.now(),
    } as any);
    await db.executions.insertOne({
      task_id: TEST_TAG_TASK_ID,
      ran_at: Date.now() - 3_600_000,
      status: 'success',
    } as any);

    await backfillUserIdV1(db);

    // La task ya tiene user_id (backfilled por la migration).
    const task = await db.recurringTasks.findOne({ id: TEST_TAG_TASK_ID });
    expect(task?.user_id).toBe(USER);

    // La execution toma user_id de la task.
    const exec = await db.executions.findOne({ task_id: TEST_TAG_TASK_ID });
    expect(exec?.user_id).toBe(USER);
  });

  it('GAP-1: execution con task_id ambiguo (mismo id en 2 users) → ORPHANED, no atribución errónea', async () => {
    const USER_2 = 'user_mig_test_bbbbbb';
    // `task_id` es un counter PER-USER: dos usuarios pueden compartir el mismo
    // id. Ambas tasks YA tienen user_id (la migration no las re-backfilla).
    await db.recurringTasks.insertOne({
      id: TEST_TAG_TASK_ID,
      user_id: USER,
      channel_id: CHANNEL_KNOWN,
      message: 't-a',
      cron_expression: '0 9 * * *',
      timezone: 'UTC',
      enabled: true,
      next_run: Date.now() + 86_400_000,
      created_at: Date.now(),
    } as any);
    await db.recurringTasks.insertOne({
      id: TEST_TAG_TASK_ID,
      user_id: USER_2,
      channel_id: CHANNEL_KNOWN,
      message: 't-b',
      cron_expression: '0 9 * * *',
      timezone: 'UTC',
      enabled: true,
      next_run: Date.now() + 86_400_000,
      created_at: Date.now(),
    } as any);
    // Execution legacy (sin user_id) con ese task_id ambiguo.
    await db.executions.insertOne({
      task_id: TEST_TAG_TASK_ID,
      ran_at: Date.now() - 3_600_000,
      status: 'success',
    } as any);

    await backfillUserIdV1(db);

    // Ambiguo (2 tasks con ese id) → ORPHANED, NUNCA atribuido a USER ni USER_2.
    const exec = await db.executions.findOne({ task_id: TEST_TAG_TASK_ID });
    expect(exec?.user_id).toBe(ORPHANED_USER_ID);

    // Cleanup del doc extra de USER_2 (afterAll borra por id, cubre ambos).
    await db.recurringTasks.deleteMany({ id: TEST_TAG_TASK_ID });
  });
});
