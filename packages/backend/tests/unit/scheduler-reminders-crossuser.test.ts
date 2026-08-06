/**
 * Regression — cross-user en el dispatch de REMINDERS (hallazgo del audit
 * adversarial, misma clase que el incidente de recurring tasks).
 *
 * El `id` de los reminders es un counter PER-USER. El claim CAS de
 * processReminder filtraba por `{ id, status: 'pending' }` sin user_id ni
 * scheduled_time → podía reclamar el reminder de OTRO usuario (incluso uno aún
 * no vencido) y dispararlo antes de tiempo, dejando el nuestro atascado.
 *
 * Insertamos primero la víctima (user B, NO vencido) para que el bug pre-fix
 * sea determinista, y verificamos que processReminder del de A solo toca el de A.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { type Db, MongoClient } from 'mongodb';
import { SchedulerService } from '../../src/services/scheduler-service';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = `teros_scheduler_rem_crossuser_${Date.now()}`;

const USER_A = 'user_aaaaaaaaaaaaaaaa';
const USER_B = 'user_bbbbbbbbbbbbbbbb';
const CHANNEL_A = 'ch_aaaaaaaaaaaaaaaa';
const CHANNEL_B = 'ch_bbbbbbbbbbbbbbbb';
const SHARED_ID = 5;

const PAST = 1_000_000_000_000; // A vencido
const FUTURE = 4_000_000_000_000; // B aún no vencido

let client: MongoClient;
let db: Db;

function makeService(dispatchSuccess: boolean): SchedulerService {
  const eventHandler = {
    handleScheduledEvent: async () => ({ success: dispatchSuccess }),
    // biome-ignore lint/suspicious/noExplicitAny: stub mínimo
  } as any;
  return new SchedulerService(db, eventHandler);
}

async function seed(): Promise<void> {
  const reminders = db.collection('scheduler_reminders');
  // B primero (no vencido): pre-fix el claim sin user_id/scheduled_time lo cogería.
  await reminders.insertOne({
    id: SHARED_ID,
    user_id: USER_B,
    channel_id: CHANNEL_B,
    message: 'Reminder de B (no vencido)',
    status: 'pending',
    scheduled_time: FUTURE,
    created_at: PAST,
  });
  await reminders.insertOne({
    id: SHARED_ID,
    user_id: USER_A,
    channel_id: CHANNEL_A,
    message: 'Reminder de A (vencido)',
    status: 'pending',
    scheduled_time: PAST,
    created_at: PAST,
  });
}

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
});

afterAll(async () => {
  await db.dropDatabase();
  await client.close();
});

beforeEach(async () => {
  await db.collection('scheduler_reminders').deleteMany({});
});

describe('processReminder — aislamiento cross-user', () => {
  it('dispatch del reminder de A no toca ni dispara el de B (no vencido)', async () => {
    await seed();
    const reminders = db.collection('scheduler_reminders');
    const reminderA = await reminders.findOne({ id: SHARED_ID, user_id: USER_A });

    // biome-ignore lint/suspicious/noExplicitAny: método privado
    await (makeService(true) as any).processReminder(reminderA);

    const a = await reminders.findOne({ id: SHARED_ID, user_id: USER_A });
    const b = await reminders.findOne({ id: SHARED_ID, user_id: USER_B });

    // A se envió.
    expect(a?.status).toBe('sent');
    // B intacto: NO se disparó antes de tiempo (el corazón del bug).
    expect(b?.status).toBe('pending');
    expect(b?.dispatching_at).toBeUndefined();
    expect(b?.terminal_at).toBeUndefined();
  });

  it('ownership-mismatch marca failed solo el reminder de A', async () => {
    await seed();
    const reminders = db.collection('scheduler_reminders');
    const reminderA = await reminders.findOne({ id: SHARED_ID, user_id: USER_A });

    // Resolver de ownership que NO matchea → verifyOwnership false.
    const svc = makeService(true);
    // biome-ignore lint/suspicious/noExplicitAny: setter
    (svc as any).setGetChannelOwnerUserIdFn(async () => 'user_otro_distinto_xx');
    // biome-ignore lint/suspicious/noExplicitAny: método privado
    await (svc as any).processReminder(reminderA);

    const a = await reminders.findOne({ id: SHARED_ID, user_id: USER_A });
    const b = await reminders.findOne({ id: SHARED_ID, user_id: USER_B });

    expect(a?.status).toBe('failed');
    expect(a?.last_error).toBe('ownership-mismatch');
    expect(b?.status).toBe('pending'); // B nunca afectado
  });
});
