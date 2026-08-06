/**
 * Integración del tick loop real + leader-gating (Bug C).
 *
 * Los otros tests llaman a processReminder/processRecurringTask directamente.
 * Aquí ejercitamos `runTick()` completo (checkReminders + checkRecurringTasks)
 * y, sobre todo, probamos el leader-gating que se cableó en Bug C: si otra
 * instancia tiene el lock, esta NO procesa. Sin esto, el gating quedaría como
 * código sin cobertura (solo verificado por tsc).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { type Db, MongoClient } from 'mongodb';
import { LEADER_LOCKS, LeaderElectionService } from '../../src/services/leader-election';
import { SchedulerService } from '../../src/services/scheduler-service';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = `teros_scheduler_tick_${Date.now()}`;

const USER = 'user_tickloop_aaaaaa';
const CHANNEL = 'ch_tickloop_aaaaaaa';
const PAST = 1_000_000_000_000; // due

let client: MongoClient;
let db: Db;

function makeService(onDispatch: () => void, leader?: LeaderElectionService): SchedulerService {
  const eventHandler = {
    handleScheduledEvent: async () => {
      onDispatch();
      return { success: true };
    },
    // biome-ignore lint/suspicious/noExplicitAny: stub
  } as any;
  const svc = new SchedulerService(db, eventHandler);
  if (leader) svc.setLeaderElection(leader);
  return svc;
}

async function seedDueTask(): Promise<void> {
  await db.collection('scheduler_recurring_tasks').insertOne({
    id: 1,
    user_id: USER,
    channel_id: CHANNEL,
    message: 't',
    cron_expression: '0 9 * * *',
    timezone: 'UTC',
    enabled: true,
    next_run: PAST,
    created_at: PAST,
  });
}

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  // El CAS de LeaderElectionService depende del índice unique en `name`.
  await db.collection('leader_locks').createIndex({ name: 1 }, { unique: true });
});

afterAll(async () => {
  await db.dropDatabase();
  await client.close();
});

beforeEach(async () => {
  await db.collection('scheduler_recurring_tasks').deleteMany({});
  await db.collection('scheduler_reminders').deleteMany({});
  await db.collection('scheduler_executions').deleteMany({});
  await db.collection('leader_locks').deleteMany({});
});

describe('runTick — loop completo', () => {
  it('procesa reminder + recurring task due en un solo tick', async () => {
    await seedDueTask();
    await db.collection('scheduler_reminders').insertOne({
      id: 1,
      user_id: USER,
      channel_id: CHANNEL,
      message: 'r',
      status: 'pending',
      scheduled_time: PAST,
      created_at: PAST,
    });

    let dispatches = 0;
    const svc = makeService(() => {
      dispatches++;
    });
    // biome-ignore lint/suspicious/noExplicitAny: método privado
    await (svc as any).runTick();
    svc.stop();

    const r = await db.collection('scheduler_reminders').findOne({ id: 1, user_id: USER });
    const t = await db.collection('scheduler_recurring_tasks').findOne({ id: 1, user_id: USER });
    expect(r?.status).toBe('sent');
    expect(t?.next_run).not.toBe(PAST); // avanzada por el claim
    expect(dispatches).toBe(2); // 1 reminder + 1 task
  });
});

describe('runTick — leader gating (Bug C)', () => {
  it('el líder procesa la task due', async () => {
    await seedDueTask();
    let dispatches = 0;
    const svc = makeService(
      () => {
        dispatches++;
      },
      new LeaderElectionService(db, 'inst-solo'),
    );
    // biome-ignore lint/suspicious/noExplicitAny: método privado
    await (svc as any).runTick();
    svc.stop();

    expect(dispatches).toBe(1);
    const t = await db.collection('scheduler_recurring_tasks').findOne({ id: 1, user_id: USER });
    expect(t?.next_run).not.toBe(PAST);
  });

  it('un follower NO procesa si otra instancia tiene el lock', async () => {
    await seedDueTask();

    // Otra instancia ya posee el lock del scheduler.
    const otherLeader = new LeaderElectionService(db, 'inst-leader');
    const acquired = await otherLeader.tryAcquire(LEADER_LOCKS.Scheduler);
    expect(acquired).toBe(true);

    // Este follower corre su tick → no consigue el lock → salta.
    let dispatches = 0;
    const follower = makeService(
      () => {
        dispatches++;
      },
      new LeaderElectionService(db, 'inst-follower'),
    );
    // biome-ignore lint/suspicious/noExplicitAny: método privado
    await (follower as any).runTick();
    follower.stop();

    // No procesó nada: la task due sigue intacta.
    expect(dispatches).toBe(0);
    const t = await db.collection('scheduler_recurring_tasks').findOne({ id: 1, user_id: USER });
    expect(t?.next_run).toBe(PAST);
  });
});
