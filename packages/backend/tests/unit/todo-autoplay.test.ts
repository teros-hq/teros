/**
 * To Do autoplay (docs/specs/todo/autoplay/spec.md, TODOAP) — backend side.
 *
 * Against a real MongoDB (MONGODB_URI, throwaway db), with the channel
 * manager, pub/sub and wake-up callback stubbed:
 *   - TodoAutoplayService: runner rules, eligibility and queue order, slots,
 *     the start sequence (state write + escalation, conversation, kick-off,
 *     wake, broadcast), rollback, re-wake and the auto-wake cap, the
 *     start-failure cap (TODOAP-REQ-32 — blocked instead of a silent retry
 *     loop), the zombie clean-up;
 *   - buildTodoInitialMessage cross-checked with the todo-list tools.json;
 *   - the running hook (handlers/message/todo-running.ts);
 *   - the todo actions: get-autoplay / set-agent-* / remove-agent with their
 *     roles and broadcasts, start-node, set-state's reply, expectedOutput
 *     (definition and set-output validation) and the re-wake count resets;
 *   - the io share actions share-io / get-io-share / unshare-io (TODOOV).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { type Db, MongoClient } from 'mongodb';
import { config } from '../../src/config';
import { getMcaActionDeps, setMcaActionDeps, type McaActionCtx } from '../../src/mca-actions';
import { todoCapability } from '../../src/mca-actions/todo';
import { updateTodoNodeRunning } from '../../src/handlers/message/todo-running';
import { __setChannelWorkerRegistryForTests } from '../../src/services/channel-worker-host';
import { SYSTEM_SENDER } from '../../src/services/board-service';
import {
  TodoAutoplayService,
  buildTodoInitialMessage,
  buildTodoRewakeMessage,
  exhaustedReason,
  startFailedReason,
  todoToday,
} from '../../src/services/todo-autoplay-service';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = `teros_todo_autoplay_test_${Date.now()}`;

const MCA_ID = 'mca.teros.todo-list';
const WS = 'ws_ap_1';
const OTHER_WS = 'ws_ap_2';
const APP = 'app_ap_1';
const OWNER = 'user_owner';
const WRITER = 'user_writer';
const READER = 'user_reader';
const ATLAS = 'agent_atlas';
const BEA = 'agent_bea';
const CAP = 2;

const ctx: McaActionCtx = { mcaId: MCA_ID, appId: APP };

/** The scope fields of a runner without a scope (TODOAP-REQ-22). */
const NO_SCOPE = { scopeNodeId: null, scopePath: null, pickUnassigned: false, scopeMissing: false };

type Any = any;

let client: MongoClient;
let db: Db;
let svc: TodoAutoplayService;
let channelSeq = 0;
let previousDeps: ReturnType<typeof getMcaActionDeps>;

const pubSub = { broadcastToTopic: mock((_topic: string, _payload: Any) => {}) };
const wake = mock(async (_channelId: string, _agentId: string, _text: string, _kind?: string) => {});
const channelManager = {
  createChannel: mock(async (_userId: string, _agentId: string, _meta: Any, _opts: Any): Promise<Any> => ({
    channelId: `ch_new_${++channelSeq}`,
  })),
  saveMessage: mock(async (_msg: Any) => {}),
  createMessageId: () => `msg_${Date.now()}_${Math.random()}`,
  getChannel: mock(async (channelId: string): Promise<Any> => db.collection('channels').findOne({ channelId })),
  getUserSender: mock(async (userId: string): Promise<Any> => ({ type: 'user', id: userId, name: `name ${userId}` })),
};

function day(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return todoToday(d);
}

async function seed(doc: Record<string, unknown>): Promise<void> {
  const now = Date.now();
  await db.collection('todo_nodes').insertOne({
    parentId: null,
    workspaceId: WS,
    text: String(doc.nodeId),
    description: '',
    instructions: '',
    completed: false,
    collapsed: false,
    position: 0,
    log: [],
    createdAt: now,
    updatedAt: now,
    kind: 'task',
    state: 'pending',
    ...doc,
  });
}

/** A pending task assigned to an agent and planned for `plannedFor`. */
function agentTask(nodeId: string, agentId: string, plannedFor: string | null, extra: Record<string, unknown> = {}) {
  return seed({
    nodeId,
    assignee: { kind: 'agent', id: agentId },
    assignedAt: 1,
    plannedFor,
    dayOrder: plannedFor ? 0 : null,
    ...extra,
  });
}

async function raw(nodeId: string): Promise<Any> {
  return db.collection('todo_nodes').findOne({ nodeId }, { projection: { _id: 0 } });
}

async function runner(agentId: string, slots: number, playEnabled: boolean, workspaceId = WS): Promise<void> {
  await db.collection('todo_autoplay_runners').insertOne({
    workspaceId,
    agentId,
    slots,
    playEnabled,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function call(action: string, body: Record<string, unknown> = {}): Promise<Any> {
  return todoCapability.actions[action](ctx, db, body);
}

async function failure(action: string, body: Record<string, unknown> = {}): Promise<Any> {
  try {
    await call(action, body);
  } catch (err) {
    return err;
  }
  throw new Error(`${action} was expected to fail`);
}

/** Let fire-and-forget scheduling settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}

function topicsOf(type: string): string[] {
  return pubSub.broadcastToTopic.mock.calls.filter((c) => c[1]?.type === type).map((c) => c[0]);
}

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  db = client.db(DB_NAME);
  previousDeps = getMcaActionDeps();
});

afterAll(async () => {
  setMcaActionDeps({ todoAutoplay: previousDeps.todoAutoplay });
  await db.dropDatabase();
  await client.close();
});

beforeEach(async () => {
  for (const col of ['todo_nodes', 'todo_autoplay_runners', 'todo_autoplay_state', 'apps', 'channels', 'workspaces', 'workspace_members', 'agents', 'shared_files']) {
    await db.collection(col).deleteMany({});
  }
  await db.collection('apps').insertOne({ appId: APP, mcaId: MCA_ID, ownerId: WS });
  await db.collection('workspaces').insertMany([
    { workspaceId: WS, ownerId: OWNER, status: 'active' },
    { workspaceId: OTHER_WS, ownerId: 'user_other', status: 'active' },
  ]);
  await db.collection('workspace_members').insertMany([
    { workspaceId: WS, userId: WRITER, role: 'write', status: 'active' },
    { workspaceId: WS, userId: READER, role: 'read', status: 'active' },
    { workspaceId: WS, userId: 'user_invited', role: 'write', status: 'pending' },
  ]);
  await db.collection('agents').insertMany([
    { agentId: ATLAS, workspaceId: WS, name: 'Atlas', avatarUrl: 'https://x/atlas.png' },
    { agentId: BEA, workspaceId: WS, name: 'Bea' },
    { agentId: 'agent_foreign', workspaceId: OTHER_WS, name: 'Foreign' },
  ]);
  pubSub.broadcastToTopic.mockClear();
  wake.mockClear();
  channelManager.createChannel.mockClear();
  channelManager.saveMessage.mockClear();
  svc = new TodoAutoplayService(db, pubSub as Any, channelManager as Any, CAP);
  svc.setWakeUpCallback(wake);
  setMcaActionDeps({ todoAutoplay: svc });
});

afterEach(() => {
  svc.stopPeriodicScheduler();
});

// =============================================================================
// Runners
// =============================================================================

describe('TodoAutoplayService — runners', () => {
  it('[TODOAP-AC-1] slots 0 on a playing runner turns play off; play with 0 slots fails INVALID_STATE', async () => {
    await svc.setAgentSlots(WS, ATLAS, 2);
    const playing = await svc.setAgentPlay(WS, ATLAS, true);
    expect(playing).toMatchObject({ agentId: ATLAS, slots: 2, playEnabled: true });
    const zero = await svc.setAgentSlots(WS, ATLAS, 0);
    expect(zero).toMatchObject({ slots: 0, playEnabled: false });
    expect(await svc.getRunner(WS, ATLAS)).toMatchObject({ slots: 0, playEnabled: false });

    let err: Any;
    try {
      await svc.setAgentPlay(WS, ATLAS, true);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'INVALID_STATE', status: 409 });
    // A runner that does not exist has 0 slots too.
    await expect(svc.setAgentPlay(WS, BEA, true)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

// =============================================================================
// Eligibility, order and slots
// =============================================================================

describe('TodoAutoplayService — scheduling', () => {
  it('[TODOAP-AC-3] starts the oldest-planned eligible task and skips planning, unplanned, tomorrow, human and other-agent tasks', async () => {
    await runner(ATLAS, 1, true);
    await agentTask('t_today', ATLAS, day(0));
    await agentTask('t_old', ATLAS, day(-2));
    await agentTask('t_planning', ATLAS, day(-3), { state: 'planning' });
    await agentTask('t_unplanned', ATLAS, null);
    await agentTask('t_tomorrow', ATLAS, day(1));
    await agentTask('t_other_agent', BEA, day(-3));
    await seed({ nodeId: 't_human', assignee: { kind: 'user', id: WRITER }, plannedFor: day(-3), dayOrder: 0 });
    await agentTask('t_other_ws', ATLAS, day(-3), { workspaceId: OTHER_WS });

    await svc.scheduleAgentTasks(WS, ATLAS);
    expect((await raw('t_old')).state).toBe('working');
    expect((await raw('t_today')).state).toBe('pending');

    // With room for everyone, only today's task joins it.
    await db.collection('todo_autoplay_runners').updateOne({ workspaceId: WS, agentId: ATLAS }, { $set: { slots: 10 } });
    await db.collection('todo_nodes').updateOne({ nodeId: 't_old' }, { $set: { running: true } });
    await svc.scheduleAgentTasks(WS, ATLAS);
    const working = (await db.collection('todo_nodes').find({ state: 'working' }).toArray()).map((n) => n.nodeId).sort();
    expect(working).toEqual(['t_old', 't_today']);
    for (const id of ['t_planning', 't_unplanned', 't_tomorrow', 't_other_agent', 't_human']) {
      expect((await raw(id)).channelId).toBeUndefined();
    }
    expect((await raw('t_other_ws')).state).toBe('pending');
  });

  it('[TODOAP-AC-3] orders by plannedFor, then dayOrder (nulls last), then tree position', async () => {
    await runner(ATLAS, 1, true);
    await agentTask('t_null_order', ATLAS, day(-1), { dayOrder: null, position: 0 });
    await agentTask('t_order_2', ATLAS, day(-1), { dayOrder: 2, position: 0 });
    await agentTask('t_order_1_low', ATLAS, day(-1), { dayOrder: 1, position: 9 });
    await agentTask('t_order_1_high', ATLAS, day(-1), { dayOrder: 1, position: 5 });
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect((await raw('t_order_1_high')).state).toBe('working');
    expect((await db.collection('todo_nodes').countDocuments({ state: 'working' }))).toBe(1);
  });

  it('[TODOAP-AC-36] one slot: successive cycles start A (yesterday), C (today, dayOrder 1), B (today, dayOrder 2), D (today, no dayOrder)', async () => {
    await runner(ATLAS, 1, true);
    // Inserted out of key order so the database's natural order cannot pass the test.
    await agentTask('t_d', ATLAS, day(0), { dayOrder: null, position: 1 });
    await agentTask('t_b', ATLAS, day(0), { dayOrder: 2, position: 3 });
    await agentTask('t_a', ATLAS, day(-1), { dayOrder: null, position: 50 });
    await agentTask('t_c', ATLAS, day(0), { dayOrder: 1, position: 4 });

    const started: string[] = [];
    for (let cycle = 0; cycle < 4; cycle++) {
      await svc.scheduleAgentTasks(WS, ATLAS);
      const working = await db.collection('todo_nodes').find({ state: 'working' }).toArray();
      expect(working).toHaveLength(1);
      started.push(working[0].nodeId);
      // Finished: moved to review, the slot is free for the next cycle.
      await db.collection('todo_nodes').updateOne({ nodeId: working[0].nodeId }, { $set: { state: 'review' } });
    }
    expect(started).toEqual(['t_a', 't_c', 't_b', 't_d']);
  });

  it('[TODOAP-AC-36] one slot: two stuck tasks are re-woken in key order regardless of insertion order', async () => {
    await runner(ATLAS, 1, true);
    await db.collection('channels').insertMany([
      { channelId: 'ch_s_late', workspaceId: WS, agentId: ATLAS },
      { channelId: 'ch_s_early', workspaceId: WS, agentId: ATLAS },
    ]);
    // Reverse key order: the later one in the queue is inserted first.
    await agentTask('s_late', ATLAS, day(0), { state: 'working', channelId: 'ch_s_late', running: false, dayOrder: null, position: 1 });
    await agentTask('s_early', ATLAS, day(0), { state: 'working', channelId: 'ch_s_early', running: false, dayOrder: 0, position: 7 });

    await svc.scheduleAgentTasks(WS, ATLAS);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0]).toBe('ch_s_early');

    await db.collection('todo_nodes').updateOne({ nodeId: 's_early' }, { $set: { state: 'review' } });
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(wake.mock.calls[1][0]).toBe('ch_s_late');
  });

  it('[TODOAP-AC-4] slots 2 with one running starts exactly one more; with two running, none', async () => {
    await runner(ATLAS, 2, true);
    await agentTask('t_running_1', ATLAS, day(-1), { state: 'working', channelId: 'ch_r1', running: true });
    await agentTask('t_a', ATLAS, day(-1));
    await agentTask('t_b', ATLAS, day(-1), { position: 1 });
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect((await raw('t_a')).state).toBe('working');
    expect((await raw('t_b')).state).toBe('pending');

    await db.collection('todo_nodes').updateOne({ nodeId: 't_a' }, { $set: { running: true } });
    channelManager.createChannel.mockClear();
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect((await raw('t_b')).state).toBe('pending');
    expect(channelManager.createChannel).not.toHaveBeenCalled();
  });

  it('does nothing without a playing runner with slots', async () => {
    await agentTask('t_a', ATLAS, day(0));
    await svc.scheduleAgentTasks(WS, ATLAS);
    await runner(ATLAS, 2, false);
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect((await raw('t_a')).state).toBe('pending');
  });
});

// =============================================================================
// Starting a task
// =============================================================================

describe('TodoAutoplayService — start', () => {
  it('[TODOAP-AC-5] moves to working, escalates the pending parent, links a headless conversation owned by the owner, sends the kick-off from Teros and wakes with autorun', async () => {
    await runner(ATLAS, 1, true);
    await seed({ nodeId: 't_parent', text: 'Admin', state: 'pending' });
    await agentTask('t_child', ATLAS, day(0), { parentId: 't_parent', text: 'Factura Q3', autoWakeCount: 3 });

    await svc.scheduleAgentTasks(WS, ATLAS);

    const child = await raw('t_child');
    expect(child.state).toBe('working');
    expect(child.channelId).toBe(`ch_new_${channelSeq}`);
    expect(child.autoWakeCount).toBe(0);
    expect(child.log.map((l: Any) => l.text)).toEqual(['Autoplay: started by Atlas', 'Linked conversation']);
    expect((await raw('t_parent')).state).toBe('working');

    expect(channelManager.createChannel).toHaveBeenCalledWith(OWNER, ATLAS, { name: 'Factura Q3' }, { workspaceId: WS, headless: true });
    const saved = channelManager.saveMessage.mock.calls[0][0];
    expect(saved).toMatchObject({ channelId: child.channelId, role: 'user', userId: OWNER, sender: SYSTEM_SENDER });
    expect(saved.content.text).toContain('You have been assigned a task. Execute it autonomously.');
    expect(saved.content.text).toContain('**Path:** Admin');
    expect(wake).toHaveBeenCalledWith(child.channelId, ATLAS, saved.content.text, 'autorun');

    const nodeTopics = topicsOf('todo_node_changed');
    expect(nodeTopics.sort()).toEqual([`todo:${OWNER}`, `todo:${READER}`, `todo:${WRITER}`]);
  });

  it('reuses the linked conversation when the task already has one', async () => {
    await runner(ATLAS, 1, true);
    await agentTask('t_again', ATLAS, day(0), { channelId: 'ch_old' });
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect(channelManager.createChannel).not.toHaveBeenCalled();
    expect((await raw('t_again')).state).toBe('working');
    expect(wake.mock.calls[0][0]).toBe('ch_old');
  });

  it('leaves the task untouched when the workspace has no owner', async () => {
    await runner(ATLAS, 1, true);
    await db.collection('workspaces').updateOne({ workspaceId: WS }, { $unset: { ownerId: '' } });
    await agentTask('t_a', ATLAS, day(0));
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect(await raw('t_a')).toMatchObject({ state: 'pending', log: [] });
  });

  it('[TODOAP-AC-15] a start whose conversation creation fails leaves the task pending with "Autoplay: start failed"', async () => {
    await runner(ATLAS, 1, true);
    await agentTask('t_fail', ATLAS, day(0));
    channelManager.createChannel.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    await svc.scheduleAgentTasks(WS, ATLAS);
    const node = await raw('t_fail');
    expect(node.state).toBe('pending');
    expect(node.channelId).toBeUndefined();
    expect(node.startFailCount).toBe(1);
    expect(node.log.at(-1).text).toBe(`Autoplay: start failed (attempt 1/${CAP}): boom`);
    expect(wake).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Start-failure cap (TODOAP-REQ-32 — a failed start never becomes a silent loop)
// =============================================================================

describe('TodoAutoplayService — start-failure cap', () => {
  /** Every createChannel throws — every start fails with this error. */
  const failStart = () => {
    channelManager.createChannel.mockImplementation(async () => {
      throw new Error('boom: no terminal host');
    });
  };
  const todoSubs = { notifySubscribers: mock((_workspaceId: string, _event: Any) => {}) };

  beforeEach(() => {
    todoSubs.notifySubscribers.mockClear();
    setMcaActionDeps({ todoSubscriptions: todoSubs as Any });
  });
  afterEach(() => {
    // failStart() replaces the shared mock's implementation for good (the
    // outer beforeEach only mockClear()s, which keeps implementations) —
    // restore the file's default so later describes start tasks normally.
    channelManager.createChannel.mockImplementation(
      async (_userId: string, _agentId: string, _meta: Any, _opts: Any): Promise<Any> => ({
        channelId: `ch_new_${++channelSeq}`,
      }),
    );
    setMcaActionDeps({ todoSubscriptions: undefined });
  });

  it('[TODOAP-AC-43] a first failed start rolls back to pending with the real error in the log', async () => {
    await runner(ATLAS, 1, true);
    await agentTask('t_sf1', ATLAS, day(0));
    failStart();
    await svc.scheduleAgentTasks(WS, ATLAS);
    const node = await raw('t_sf1');
    expect(node.state).toBe('pending');
    expect(node.channelId).toBeUndefined();
    expect(node.startFailCount).toBe(1);
    expect(node.log.at(-1).text).toBe(`Autoplay: start failed (attempt 1/${CAP}): boom: no terminal host`);
    expect(wake).not.toHaveBeenCalled();
  });

  it('[TODOAP-AC-43] the second consecutive failed start blocks the task with the error as the reason — no third attempt, ever', async () => {
    await runner(ATLAS, 1, true);
    await agentTask('t_sf2', ATLAS, day(0));
    failStart();
    await svc.scheduleAgentTasks(WS, ATLAS); // attempt 1 → back to pending
    await svc.scheduleAgentTasks(WS, ATLAS); // attempt 2 → blocked
    const node = await raw('t_sf2');
    expect(node.state).toBe('blocked');
    expect(node.blockedReason).toBe(startFailedReason(CAP, 'boom: no terminal host'));
    expect(node.running).toBe(false);
    expect(node.startFailCount).toBe(0); // clean for the manual retry
    const texts = node.log.map((l: Any) => l.text);
    expect(texts.filter((t: string) => t.startsWith('Autoplay: start failed'))).toHaveLength(2);
    expect(texts.at(-1)).toBe(`working → blocked: ${startFailedReason(CAP, 'boom: no terminal host')}`);
    // A blocked task is not eligible: more cycles never attempt a third start.
    await svc.scheduleAgentTasks(WS, ATLAS);
    await svc.scheduleAgentTasks(WS, ATLAS);
    const after = await raw('t_sf2');
    expect(after.state).toBe('blocked');
    expect(after.log.map((l: Any) => l.text).filter((t: string) => t.startsWith('Autoplay: start failed'))).toHaveLength(2);
    expect(channelManager.createChannel).toHaveBeenCalledTimes(2);
  });

  it('[TODOAP-AC-43] blocking on the cap emits todo.task_blocked with the reason for the owner/coordinator', async () => {
    await runner(ATLAS, 1, true);
    await agentTask('t_sf2b', ATLAS, day(0));
    failStart();
    await svc.scheduleAgentTasks(WS, ATLAS); // attempt 1 → back to pending
    await svc.scheduleAgentTasks(WS, ATLAS); // attempt 2 → blocked
    expect((await raw('t_sf2b')).state).toBe('blocked');
    const blockedEvents = todoSubs.notifySubscribers.mock.calls.filter((c: Any[]) => c[1]?.eventType === 'task_blocked');
    expect(blockedEvents).toHaveLength(1);
    expect(blockedEvents[0][1].payload).toMatchObject({ nodeId: 't_sf2b', reason: startFailedReason(CAP, 'boom: no terminal host') });
  });

  it('[TODOAP-AC-43] a successful start resets the count — failures after it start over', async () => {
    await runner(ATLAS, 1, true);
    await agentTask('t_sf3', ATLAS, day(0));
    failStart();
    await svc.scheduleAgentTasks(WS, ATLAS); // failure 1
    channelManager.createChannel.mockImplementationOnce(async (): Promise<Any> => ({ channelId: `ch_new_${++channelSeq}` }));
    await svc.scheduleAgentTasks(WS, ATLAS); // success — counter back to 0
    const ok = await raw('t_sf3');
    expect(ok.state).toBe('working');
    expect(ok.startFailCount).toBe(0);
    // The turn ends and the task is queued again — it fails twice more and
    // blocks only on the second NEW failure.
    await db.collection('todo_nodes').updateOne({ nodeId: 't_sf3' }, { $set: { state: 'pending', running: false }, $unset: { channelId: '' } });
    failStart();
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect(await raw('t_sf3')).toMatchObject({ state: 'pending', startFailCount: 1 });
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect((await raw('t_sf3')).state).toBe('blocked');
  });

  it('[TODOAP-AC-43] unblocking is the manual retry: set-state resets the counter and the task leaves blocked', async () => {
    await runner(ATLAS, 1, true);
    await agentTask('t_sf4', ATLAS, day(0));
    failStart();
    await svc.scheduleAgentTasks(WS, ATLAS);
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect((await raw('t_sf4')).state).toBe('blocked');
    const res = await call('set-state', { nodeId: 't_sf4', state: 'working', reply: 'terminal host fixed, go', callerUserId: OWNER });
    expect(res.node).toMatchObject({ state: 'working', blockedReason: null });
    const node = await raw('t_sf4');
    expect(node.startFailCount).toBe(0);
    expect(node.running).toBe(false);
  });

  it('[TODOAP-AC-43] an orphaned working task whose start fails twice is blocked too — nothing in limbo', async () => {
    await runner(ATLAS, 1, true);
    await agentTask('t_sf5', ATLAS, day(0), { state: 'working' });
    failStart();
    await svc.scheduleAgentTasks(WS, ATLAS); // failure 1 (stays working)
    await svc.scheduleAgentTasks(WS, ATLAS); // failure 2 → blocked
    const node = await raw('t_sf5');
    expect(node.state).toBe('blocked');
    expect(node.blockedReason).toBe(startFailedReason(CAP, 'boom: no terminal host'));
    expect(node.running).toBe(false);
    expect(node.channelId).toBeUndefined();
    expect(node.startFailCount).toBe(0);
    expect(node.log.at(-1).text).toBe(`working → blocked: ${startFailedReason(CAP, 'boom: no terminal host')}`);
  });
});

// =============================================================================
// Kick-off message
// =============================================================================

describe('buildTodoInitialMessage', () => {
  const toolsJson = JSON.parse(
    readFileSync(join(__dirname, '../../../../mcas/mca.teros.todo-list/tools.json'), 'utf-8'),
  ) as { tools: Array<{ name: string }> };
  const toolNames = new Set(toolsJson.tools.map((t) => t.name));

  it('[TODOAP-AC-6] names the input file, asks for a form through todo-list_set-output and names only todo-list tools', () => {
    const msg = buildTodoInitialMessage(
      {
        nodeId: 'tn_1',
        parentId: 'tn_0',
        workspaceId: WS,
        text: 'Factura Q3',
        description: 'Invoice for Q3',
        instructions: '- [ ] Collect hours\n- [ ] Send',
        completed: false,
        collapsed: false,
        position: 0,
        log: [],
        createdAt: 0,
        updatedAt: 0,
        kind: 'task',
        state: 'pending',
        plannedFor: '2026-10-27',
        plannedTime: '09:30',
        input: { format: 'file', objectId: 'obj_1', url: 'https://x/obj_1', name: 'hours.pdf', mime: 'application/pdf', size: 1234 },
        expectedOutput: { format: 'form' },
      },
      { path: ['Teros', 'Admin'] },
    );
    const order = [
      'You have been assigned a task. Execute it autonomously.',
      '## Task: Factura Q3',
      '`tn_1`',
      'Teros › Admin',
      '2026-10-27 at 09:30',
      '## Description',
      'Invoice for Q3',
      '## Instructions',
      '- [ ] Collect hours',
      '## Input',
      'hours.pdf',
      '## Expected output',
      '**Format:** form',
      '## How to work',
    ];
    let at = -1;
    for (const piece of order) {
      const next = msg.indexOf(piece, at + 1);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
    expect(msg).toContain('`todo-list_get-node`');
    expect(msg).toMatch(/Deliver it with `todo-list_set-output`.*format: "form", fields, values/);
    expect(msg).toContain(
      '- If you hit the execution limit (tool calls blocked), add a progress note with `todo-list_add-log-entry` summarising what is done and what remains — this resets your execution counter so you can continue working.',
    );

    // Every tool-like name in backticks is a todo-list tool that exists.
    const named = [...msg.matchAll(/`([a-z][a-z0-9-]*_[a-z][a-z-]*)`/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) {
      expect(name.startsWith('todo-list_')).toBe(true);
      expect(toolNames.has(name.slice('todo-list_'.length))).toBe(true);
    }
    for (const tool of ['get-node', 'set-progress', 'add-log-entry', 'toggle-instruction-item', 'set-output', 'set-state']) {
      expect(named).toContain(`todo-list_${tool}`);
    }
  });

  it('[TODOAP-AC-27] tells the agent to drive the percentage from the instruction checklist', () => {
    const msg = buildTodoInitialMessage(
      {
        nodeId: 'tn_27', parentId: null, workspaceId: WS, text: 'Z', description: '', instructions: '- [ ] a\n- [ ] b',
        completed: false, collapsed: false, position: 0, log: [], createdAt: 0, updatedAt: 0,
      },
      { path: [] },
    );
    const howTo = msg.slice(msg.indexOf('## How to work'));
    expect(howTo).toContain(
      '- Treat the instruction checklist as your plan. After finishing each item, tick it with `todo-list_toggle-instruction-item` and set the progress with `todo-list_set-progress` to the share of items done (3 of 7 items → 43 %), with a note in plain language through `todo-list_add-log-entry`.',
    );
    expect(howTo).toContain(
      '- If there is no checklist, the operator appreciates being kept informed of progress — update the percentage with `todo-list_set-progress` from your own plan after each significant step, with a note through `todo-list_add-log-entry`.',
    );
    expect(howTo).not.toContain('report progress with');
    expect(howTo).not.toContain('already in progress without a conversation');
  });

  it('[TODOAP-AC-33] the kick-off and the re-wake tell the agent to block with the exact need instead of review', () => {
    const msg = buildTodoInitialMessage(
      {
        nodeId: 'tn_33', parentId: null, workspaceId: WS, text: 'Z', description: '', instructions: '',
        completed: false, collapsed: false, position: 0, log: [], createdAt: 0, updatedAt: 0,
      },
      { path: [] },
    );
    const howTo = msg.slice(msg.indexOf('## How to work'));
    const rule =
      '- Never send to review what you could not finish. When something you need is missing — a tool permission denied in this headless conversation, access you lack, a decision or data only the operator has — set the state to `blocked` with `todo-list_set-state` and a reason that names exactly what is needed (for example: "Permission needed: assign the task to a user"), instead of `review` with a note. `review` means the deliverable is complete.';
    expect(howTo).toContain(rule);
    // Right after the "stuck or need something" bullet.
    const stuck = howTo.indexOf('- If you are stuck or need something from the operator');
    expect(stuck).toBeGreaterThan(-1);
    expect(howTo.indexOf(rule)).toBe(howTo.indexOf('\n', stuck) + 1);
    expect(howTo).toContain('Permission needed: assign the task to a user');

    const rewake = buildTodoRewakeMessage({ text: 'Z' });
    expect(rewake).toContain(
      'If something you need is missing (a denied permission, access, a decision), set the state to blocked with the exact need as the reason — never send to review what you could not finish.',
    );
    expect(rewake).toContain(
      'The operator appreciates being kept informed of progress — update the percentage with set-progress after each significant step.',
    );
  });

  it('[TODOAP-AC-6] defaults to markdown output and says when there are no instructions', () => {
    const msg = buildTodoInitialMessage(
      {
        nodeId: 'tn_2', parentId: null, workspaceId: WS, text: 'X', description: '', instructions: '',
        completed: false, collapsed: false, position: 0, log: [], createdAt: 0, updatedAt: 0,
        input: { format: 'form', fields: [{ id: 'f1', type: 'text', label: 'Tax id' }] as Any, values: { f1: 'B123' } },
      },
      { path: [] },
    );
    expect(msg).toContain('No instructions provided.');
    expect(msg).toContain('"f1": "B123"');
    expect(msg).toContain('deliver markdown');
  });

  const bare = {
    nodeId: 'tn_3', parentId: null, workspaceId: WS, text: 'Y', description: '', instructions: '',
    completed: false, collapsed: false, position: 0, log: [], createdAt: 0, updatedAt: 0,
  };
  const WIN = 'If the instructions state a different format, the instructions win.';

  function expectedSection(msg: string): string {
    return msg.slice(msg.indexOf('## Expected output'), msg.indexOf('## How to work'));
  }

  it('[TODOAP-AC-17] renders a file definition with its type and description', () => {
    const msg = buildTodoInitialMessage(
      { ...bare, expectedOutput: { format: 'file', fileType: 'pdf', description: 'The signed invoice' } },
      { path: [] },
    );
    const section = expectedSection(msg);
    expect(section).toContain('**Format:** file');
    expect(section).toContain('**Description:** The signed invoice');
    expect(section).toContain('**File type:** PDF (.pdf)');
    expect(section).toContain('format: "file", name, mime, data: base64');
    expect(section).toContain(WIN);
  });

  it('[TODOAP-AC-17] renders an html file definition with its exact file type', () => {
    const msg = buildTodoInitialMessage(
      { ...bare, expectedOutput: { format: 'file', fileType: 'html' } },
      { path: [] },
    );
    expect(expectedSection(msg)).toContain('**File type:** HTML page (.html)');
  });

  it('[TODOAP-AC-17] lists every field of a form definition as name · type · required', () => {
    const msg = buildTodoInitialMessage(
      {
        ...bare,
        expectedOutput: {
          format: 'form',
          description: 'Customer data',
          fields: [
            { id: 'taxId', type: 'text', label: 'Tax id', required: true },
            { id: 'employees', type: 'number', label: 'Employees' },
          ] as Any,
        },
      },
      { path: [] },
    );
    const section = expectedSection(msg);
    expect(section).toContain('**Description:** Customer data');
    expect(section).toContain('- `taxId` · text · required');
    expect(section).toContain('- `employees` · number · optional');
    expect(section).toContain(WIN);
  });

  it('[TODOAP-AC-17] without a definition says none is defined and to deliver markdown', () => {
    const section = expectedSection(buildTodoInitialMessage(bare as Any, { path: [] }));
    expect(section).toContain('No expected output defined: deliver markdown unless the instructions say otherwise.');
    expect(section).toContain(WIN);
  });
});

// =============================================================================
// Re-wake and the cap
// =============================================================================

describe('TodoAutoplayService — re-wake', () => {
  it('[TODOAP-AC-7] re-wakes a stuck task in its conversation and counts it; at the cap it is blocked instead', async () => {
    await runner(ATLAS, 1, true);
    await agentTask('t_stuck', ATLAS, day(-1), { state: 'working', channelId: 'ch_s', running: false, autoWakeCount: 0 });
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0]).toBe('ch_s');
    expect(wake.mock.calls[0][2]).toBe(
      'Task "t_stuck" is still in progress. Continue where you left off. The operator appreciates being kept informed of progress — update the percentage with set-progress after each significant step. If you are blocked or need help, set the state to blocked with your question. If something you need is missing (a denied permission, access, a decision), set the state to blocked with the exact need as the reason — never send to review what you could not finish. If you hit the execution limit, add a progress note summarising what is done and what remains — this resets your execution counter so you can continue.',
    );
    expect(wake.mock.calls[0][3]).toBe('autorun');
    expect((await raw('t_stuck')).autoWakeCount).toBe(1);

    await db.collection('todo_nodes').updateOne({ nodeId: 't_stuck' }, { $set: { autoWakeCount: CAP } });
    wake.mockClear();
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect(wake).not.toHaveBeenCalled();
    const blocked = await raw('t_stuck');
    expect(blocked.state).toBe('blocked');
    expect(blocked.blockedReason).toBe(exhaustedReason(CAP));
    expect(blocked.blockedReason).toBe(`Stopped after ${CAP} automatic wake-ups without finishing. Reply to continue.`);
    expect(blocked.running).toBe(false);
  });

  it('[TODOAP-AC-23] with one slot, a turn ending on a working task starts and re-wakes nothing; the cycle re-wakes it and starts the pending task only once it is auto-blocked', async () => {
    await runner(ATLAS, 1, true);
    await db.collection('channels').insertOne({ channelId: 'ch_end', workspaceId: WS, agentId: ATLAS });
    await agentTask('t_left', ATLAS, day(-1), { state: 'working', channelId: 'ch_end', running: true, autoWakeCount: 0 });
    await agentTask('t_new', ATLAS, day(0));

    // Turn end: nothing started, nothing re-woken.
    await updateTodoNodeRunning(db, svc, 'ch_end', false);
    await settle();
    expect(wake).not.toHaveBeenCalled();
    expect((await raw('t_new')).state).toBe('pending');
    expect((await raw('t_left')).autoWakeCount).toBe(0);

    // The cycle re-wakes the working task and starts nothing new.
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0]).toBe('ch_end');
    expect((await raw('t_left')).autoWakeCount).toBe(1);
    expect((await raw('t_new')).state).toBe('pending');

    // Cap reached: the cycle auto-blocks it, and the freed slot goes to the pending task.
    await db.collection('todo_nodes').updateOne({ nodeId: 't_left' }, { $set: { autoWakeCount: CAP } });
    wake.mockClear();
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect((await raw('t_left')).state).toBe('blocked');
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect((await raw('t_new')).state).toBe('working');
    expect(wake.mock.calls.filter((c) => c[0] === 'ch_end')).toHaveLength(0);
  });

  it('a working task whose turn is running, or that never ran, is not re-woken', async () => {
    await runner(ATLAS, 2, true);
    await agentTask('t_running', ATLAS, day(-1), { state: 'working', channelId: 'ch_1', running: true });
    await agentTask('t_unstarted', ATLAS, day(-1), { state: 'working', channelId: 'ch_2' });
    await svc.scheduleAgentTasks(WS, ATLAS);
    // running: neither stuck nor orphaned. Unstarted with a conversation but no
    // running flag at all (never ran): not stuck (`running` must be false, an
    // absent field does not match) and not orphaned (it has a conversation) —
    // pre-existing behaviour, unchanged by TODOAP-REQ-27.
    expect(wake).not.toHaveBeenCalled();
    expect(channelManager.createChannel).not.toHaveBeenCalled();
  });

  it('[TODOAP-AC-38] an orphaned working task (no conversation) is started by the cycle: conversation + kick-off + autorun, no manual action', async () => {
    await runner(ATLAS, 1, true);
    // The repro shape: worked by hand in a chat, sent back from review with a
    // note — no channelId, no running, autoWakeCount 0.
    await agentTask('t_orphan', ATLAS, day(-1), { state: 'working', autoWakeCount: 0 });

    await svc.scheduleAgentTasks(WS, ATLAS);

    const node = await raw('t_orphan');
    expect(node.state).toBe('working');
    expect(node.channelId).toBe(`ch_new_${channelSeq}`);
    expect(node.autoWakeCount).toBe(0); // a start resets it; it never counts re-wakes
    expect(node.log.map((l: Any) => l.text)).toEqual(['Autoplay: started by Atlas', 'Linked conversation']);
    expect(channelManager.createChannel).toHaveBeenCalledWith(OWNER, ATLAS, { name: 't_orphan' }, { workspaceId: WS, headless: true });
    const saved = channelManager.saveMessage.mock.calls[0][0];
    expect(saved).toMatchObject({ channelId: node.channelId, role: 'user', userId: OWNER, sender: SYSTEM_SENDER });
    // The kick-off of a resumed task points at the log, where the send-back note lives.
    expect(saved.content.text).toContain('This task was already in progress without a conversation. Read its log with `todo-list_get-node`');
    expect(wake).toHaveBeenCalledWith(node.channelId, ATLAS, saved.content.text, 'autorun');
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('[TODOAP-AC-38] orphans are started whatever their planned day, and a running orphan is left alone', async () => {
    // 4 slots: one is held by the running orphan's turn, three remain for the
    // two orphan candidates and the pending task.
    await runner(ATLAS, 4, true);
    await agentTask('t_orph_future', ATLAS, day(2), { state: 'working' }); // planned ahead: still picked up
    await agentTask('t_orph_unplanned', ATLAS, null, { state: 'working' }); // no day: still picked up
    await agentTask('t_orph_running', ATLAS, day(-1), { state: 'working', running: true }); // a turn runs: untouched
    await agentTask('t_orph_pending', ATLAS, day(0)); // pending: eligible, but after the orphans

    await svc.scheduleAgentTasks(WS, ATLAS);

    expect((await raw('t_orph_future')).channelId).toBeTruthy();
    expect((await raw('t_orph_unplanned')).channelId).toBeTruthy();
    expect((await raw('t_orph_running')).channelId).toBeUndefined(); // running ≠ orphan candidate
    expect((await raw('t_orph_pending')).state).toBe('working');
  });

  it('[TODOAP-AC-38] order: stuck re-wake first, then orphaned starts, then pending starts', async () => {
    await runner(ATLAS, 3, true);
    await db.collection('channels').insertOne({ channelId: 'ch_stuck', workspaceId: WS, agentId: ATLAS });
    await agentTask('t_stuck', ATLAS, day(0), { state: 'working', channelId: 'ch_stuck', running: false, dayOrder: 5 });
    await agentTask('t_orphan', ATLAS, day(0), { state: 'working', dayOrder: 0 }); // earlier in the queue than the stuck one
    await agentTask('t_pending', ATLAS, day(-1), { dayOrder: 0 }); // older day than both

    await svc.scheduleAgentTasks(WS, ATLAS);

    // The stuck re-wake runs first even though the orphan and the pending task
    // rank earlier in the queue; then the orphan start; the pending one last.
    expect(wake.mock.calls[0][0]).toBe('ch_stuck');
    const orphanChannel = (await raw('t_orphan')).channelId;
    const pendingChannel = (await raw('t_pending')).channelId;
    expect(wake.mock.calls.map((c: Any) => c[0])).toEqual(['ch_stuck', orphanChannel, pendingChannel]);
    expect(channelManager.createChannel).toHaveBeenCalledTimes(2);
  });

  it('[TODOAP-AC-38] one slot with a stuck and an orphan task: the stuck one is re-woken, the orphan waits; the next cycle starts it', async () => {
    await runner(ATLAS, 1, true);
    await db.collection('channels').insertOne({ channelId: 'ch_s2', workspaceId: WS, agentId: ATLAS });
    await agentTask('t_stuck2', ATLAS, day(0), { state: 'working', channelId: 'ch_s2', running: false });
    await agentTask('t_orphan2', ATLAS, day(0), { state: 'working' });

    await svc.scheduleAgentTasks(WS, ATLAS);
    expect(wake.mock.calls.map((c: Any) => c[0])).toEqual(['ch_s2']);
    expect((await raw('t_orphan2')).channelId).toBeUndefined();

    // The stuck turn finishes (review) — the freed slot goes to the orphan.
    await db.collection('todo_nodes').updateOne({ nodeId: 't_stuck2' }, { $set: { state: 'review' } });
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect((await raw('t_orphan2')).channelId).toBeTruthy();
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it('[TODOAP-AC-38] an orphan whose conversation cannot be created stays working without a conversation (no rollback of the state)', async () => {
    await runner(ATLAS, 1, true);
    await agentTask('t_orph_fail', ATLAS, day(0), { state: 'working' });
    channelManager.createChannel.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    await svc.scheduleAgentTasks(WS, ATLAS);
    const node = await raw('t_orph_fail');
    // It was already working: nothing to roll back — it stays as it was, minus
    // the "Autoplay: started by" log entry, and is retried by the next cycle
    // (up to the start-failure cap, TODOAP-REQ-32).
    expect(node.state).toBe('working');
    expect(node.channelId).toBeUndefined();
    expect(node.startFailCount).toBe(1);
    expect(node.log.at(-1).text).toBe(`Autoplay: start failed (attempt 1/${CAP}): boom`);
    expect(wake).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Running flag
// =============================================================================

describe('running flag', () => {
  it('[TODOAP-AC-9] a turn sets running true at its start and false at its end, broadcasting both times', async () => {
    await db.collection('channels').insertOne({ channelId: 'ch_turn', workspaceId: WS, agentId: ATLAS });
    await agentTask('t_turn', ATLAS, day(0), { state: 'working', channelId: 'ch_turn', running: false });

    const started = await updateTodoNodeRunning(db, svc, 'ch_turn', true);
    expect(started?.running).toBe(true);
    expect((await raw('t_turn')).running).toBe(true);
    expect(topicsOf('todo_node_changed')).toHaveLength(3);

    const ended = await updateTodoNodeRunning(db, svc, 'ch_turn', false);
    expect(ended?.running).toBe(false);
    expect((await raw('t_turn')).running).toBe(false);
    expect(topicsOf('todo_node_changed')).toHaveLength(6);

    // Unchanged flag or unlinked channel: no write, no broadcast.
    expect(await updateTodoNodeRunning(db, svc, 'ch_turn', false)).toBeNull();
    expect(await updateTodoNodeRunning(db, svc, 'ch_unknown', true)).toBeNull();
    expect(topicsOf('todo_node_changed')).toHaveLength(6);
  });

  it('[TODOAP-AC-23] the end of a turn does not run the scheduling cycle; the next cycle starts the task', async () => {
    await runner(ATLAS, 1, true);
    await db.collection('channels').insertOne({ channelId: 'ch_done', workspaceId: WS, agentId: ATLAS });
    await agentTask('t_done', ATLAS, day(0), { state: 'review', channelId: 'ch_done', running: true });
    await agentTask('t_next', ATLAS, day(0));
    await updateTodoNodeRunning(db, svc, 'ch_done', false);
    await settle();
    expect((await raw('t_next')).state).toBe('pending');
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect((await raw('t_next')).state).toBe('working');
  });

  it('[TODOAP-AC-9] the zombie clean-up resets running on a task whose channel is idle', async () => {
    await runner(ATLAS, 1, true);
    await db.collection('channels').insertMany([
      { channelId: 'ch_zombie', workspaceId: WS, running: false },
      { channelId: 'ch_live', workspaceId: WS, running: true },
    ]);
    await agentTask('t_zombie', ATLAS, day(1), { state: 'working', channelId: 'ch_zombie', running: true });
    await agentTask('t_live', ATLAS, day(1), { state: 'working', channelId: 'ch_live', running: true });
    await (svc as Any)._runPeriodicSchedule();
    const zombie = await raw('t_zombie');
    expect(zombie.running).toBe(false);
    expect(zombie.log.at(-1).text).toBe('Autoplay: running flag reset');
    expect((await raw('t_live')).running).toBe(true);
  });
});

// =============================================================================
// One working per runner — leftover demotion (TODOAP-REQ-28) and the idle
// sweep (TODOAP-REQ-29)
// =============================================================================

describe('TodoAutoplayService — one working per runner', () => {
  it('[TODOAP-AC-39] a runner with 2+ orphaned working tasks resumes the first and demotes the rest to pending', async () => {
    await runner(ATLAS, 1, true);
    // The repro shape: the agent left two tasks working (turn budget spent on
    // both, no conversation on either — worked by hand or sent back). Queue
    // order: t_keep (dayOrder 0) before t_demote (dayOrder 1).
    await agentTask('t_demote', ATLAS, day(0), { state: 'working', dayOrder: 1 });
    await agentTask('t_keep', ATLAS, day(0), { state: 'working', dayOrder: 0 });

    await svc.scheduleAgentTasks(WS, ATLAS);

    // The first working task is resumed (started with a conversation).
    expect((await raw('t_keep')).state).toBe('working');
    expect((await raw('t_keep')).channelId).toBeTruthy();
    // The leftover goes back to pending, keeping its day, position and log.
    const demoted = await raw('t_demote');
    expect(demoted.state).toBe('pending');
    expect(demoted.plannedFor).toBe(day(0));
    expect(demoted.dayOrder).toBe(1);
    expect(demoted.log.at(-1).text).toBe('Autoplay: back to pending — no free slot for this working task');
    // Exactly one working task of the agent remains.
    expect(await db.collection('todo_nodes').countDocuments({ workspaceId: WS, state: 'working' })).toBe(1);
  });

  it('[TODOAP-AC-39] stuck leftovers are demoted too, after the re-wake; a pending task is not started while a working one is resumed', async () => {
    await runner(ATLAS, 1, true);
    await db.collection('channels').insertOne({ channelId: 'ch_stuck_d', workspaceId: WS, agentId: ATLAS });
    // One stuck (with a conversation) and one orphaned (without), both working.
    // The cycle's priority is stuck re-wake first (REQ-18), whatever the queue
    // order — the orphan ranks earlier in the day panel but the stuck task
    // already has a conversation to resume.
    await agentTask('t_stuck_d', ATLAS, day(0), { state: 'working', channelId: 'ch_stuck_d', running: false, dayOrder: 1 });
    await agentTask('t_orphan_d', ATLAS, day(0), { state: 'working', dayOrder: 0 });
    await agentTask('t_pending_d', ATLAS, day(0), { dayOrder: 2 });

    await svc.scheduleAgentTasks(WS, ATLAS);

    // The stuck one is re-woken in its conversation (stuck before orphaned).
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0]).toBe('ch_stuck_d');
    // The orphan is the leftover beyond the free slot: demoted to pending.
    const orphan = await raw('t_orphan_d');
    expect(orphan.state).toBe('pending');
    expect(orphan.log.at(-1).text).toBe('Autoplay: back to pending — no free slot for this working task');
    // The pending task was not started — the slot went to the working one.
    expect((await raw('t_pending_d')).state).toBe('pending');

    // The re-woken task finishes → the freed slot goes to the demoted orphan
    // (now pending, earlier in the queue) before the other pending task:
    // working-before-pending while it was working, queue order once pending.
    await db.collection('todo_nodes').updateOne({ nodeId: 't_stuck_d' }, { $set: { state: 'review' } });
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect(wake).toHaveBeenCalledTimes(2);
    expect((await raw('t_orphan_d')).state).toBe('working');
    expect((await raw('t_orphan_d')).channelId).toBeTruthy(); // started with a fresh conversation
    expect((await raw('t_pending_d')).state).toBe('pending');
  });

  it('[TODOAP-AC-39] two stuck working tasks with one free slot: the first is re-woken, the second is demoted to pending', async () => {
    await runner(ATLAS, 1, true);
    await db.collection('channels').insertMany([
      { channelId: 'ch_stuck_1st', workspaceId: WS, agentId: ATLAS },
      { channelId: 'ch_stuck_2nd', workspaceId: WS, agentId: ATLAS },
    ]);
    await agentTask('t_stuck_2nd', ATLAS, day(0), { state: 'working', channelId: 'ch_stuck_2nd', running: false, dayOrder: 1 });
    await agentTask('t_stuck_1st', ATLAS, day(0), { state: 'working', channelId: 'ch_stuck_1st', running: false, dayOrder: 0 });

    await svc.scheduleAgentTasks(WS, ATLAS);

    // The first in queue order is re-woken in its conversation.
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0]).toBe('ch_stuck_1st');
    // The second is a leftover: demoted to pending, conversation kept.
    const second = await raw('t_stuck_2nd');
    expect(second.state).toBe('pending');
    expect(second.channelId).toBe('ch_stuck_2nd');
    expect(second.log.at(-1).text).toBe('Autoplay: back to pending — no free slot for this working task');
    // Only one working task of the agent remains.
    expect(await db.collection('todo_nodes').countDocuments({ workspaceId: WS, state: 'working' })).toBe(1);
  });

  it('[TODOAP-AC-39] a working task whose turn is running is never demoted at pickup (it holds a slot); the leftover waits for the idle sweep', async () => {
    await runner(ATLAS, 1, true);
    // The single slot is held by a live turn; a second working task exists.
    await agentTask('t_live_hold', ATLAS, day(0), { state: 'working', channelId: 'ch_hold', running: true });
    await agentTask('t_leftover_hold', ATLAS, day(0), { state: 'working', dayOrder: 1 });

    await svc.scheduleAgentTasks(WS, ATLAS);

    // The live one is untouched (not a candidate — it holds the slot).
    expect((await raw('t_live_hold')).state).toBe('working');
    expect((await raw('t_live_hold')).running).toBe(true);
    // No pickup happened (no free slot): the leftover stays working — next in
    // line to be resumed, NOT demoted. No wake, no new conversation.
    expect((await raw('t_leftover_hold')).state).toBe('working');
    expect(wake).not.toHaveBeenCalled();
    expect(channelManager.createChannel).not.toHaveBeenCalled();

    // The "agent never comes back" complement: the leftover is idle, and the
    // sweep demotes it after the timeout.
    await db.collection('todo_nodes').updateOne(
      { nodeId: 't_leftover_hold' },
      { $set: { updatedAt: Date.now() - 5 * 60 * 60 * 1000 } },
    );
    await (svc as Any)._runPeriodicSchedule();
    expect((await raw('t_leftover_hold')).state).toBe('pending');
    expect((await raw('t_live_hold')).state).toBe('working'); // the live one still untouched
  });

  it('[TODOAP-AC-39] an unplanned leftover is planned for today on demotion (never parked invisible)', async () => {
    await runner(ATLAS, 1, true);
    // The slot goes to the first working task (planned); the unplanned one is
    // the leftover beyond the free slot.
    await agentTask('t_hold_unp', ATLAS, day(0), { state: 'working', dayOrder: 0 });
    // Unplanned working leftover (the shape a hand-worked task gets).
    await agentTask('t_left_unp', ATLAS, null, { state: 'working', dayOrder: 1 });

    await svc.scheduleAgentTasks(WS, ATLAS);

    const demoted = await raw('t_left_unp');
    expect(demoted.state).toBe('pending');
    expect(demoted.plannedFor).toBe(day(0)); // today: visible to the next pickup
  });

  it('[TODOAP-AC-39] the end of a turn does NOT demote the task — it stays working until the next pickup or the idle sweep', async () => {
    await runner(ATLAS, 1, true);
    await db.collection('channels').insertOne({ channelId: 'ch_end_keep', workspaceId: WS, agentId: ATLAS });
    await agentTask('t_end_keep', ATLAS, day(0), { state: 'working', channelId: 'ch_end_keep', running: true });
    await agentTask('t_end_next', ATLAS, day(0), { dayOrder: 1 });

    // The turn ends (running → false): the hook must not demote.
    await updateTodoNodeRunning(db, svc, 'ch_end_keep', false);
    await settle();
    const afterTurn = await raw('t_end_keep');
    expect(afterTurn.state).toBe('working'); // still working — it may be resumed right after
    const lastLog = afterTurn.log?.at(-1)?.text;
    expect(lastLog).not.toBe('Autoplay: back to pending — no free slot for this working task');

    // The next cycle re-wakes it (Pablo: resume before anything new).
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect(wake).toHaveBeenCalledWith('ch_end_keep', ATLAS, expect.any(String), 'autorun');
    expect((await raw('t_end_keep')).state).toBe('working');
    expect((await raw('t_end_next')).state).toBe('pending');
  });

  it('[TODOAP-AC-39] a demoted task is re-picked by the normal flow on a later cycle', async () => {
    await runner(ATLAS, 1, true);
    await agentTask('t_re_pick', ATLAS, day(0), { state: 'working', dayOrder: 1 });
    await agentTask('t_first_pick', ATLAS, day(0), { state: 'working', dayOrder: 0 });

    await svc.scheduleAgentTasks(WS, ATLAS);
    expect((await raw('t_re_pick')).state).toBe('pending');

    // The resumed task finishes; the freed slot goes to the demoted one.
    await db.collection('todo_nodes').updateOne({ nodeId: 't_first_pick' }, { $set: { state: 'review' } });
    await svc.scheduleAgentTasks(WS, ATLAS);
    const rePicked = await raw('t_re_pick');
    expect(rePicked.state).toBe('working');
    expect(rePicked.channelId).toBeTruthy(); // started with a fresh conversation
  });
});

describe('TodoAutoplayService — idle working sweep', () => {
  it('[TODOAP-AC-40] an idle working task with no live turn is swept to pending after the timeout', async () => {
    // No playing runner at all — the "agent never came back" case.
    await agentTask('t_idle', ATLAS, day(0), { state: 'working', channelId: 'ch_idle', running: false });
    // Age the node past the timeout (constructor default 4 h).
    await db.collection('todo_nodes').updateOne({ nodeId: 't_idle' }, { $set: { updatedAt: Date.now() - 5 * 60 * 60 * 1000 } });

    await (svc as Any)._runPeriodicSchedule();

    const swept = await raw('t_idle');
    expect(swept.state).toBe('pending');
    expect(swept.channelId).toBe('ch_idle'); // kept for reuse
    expect(swept.plannedFor).toBe(day(0));
    expect(swept.log.at(-1).text).toBe('Autoplay: back to pending — working without activity for too long');
  });

  it('[TODOAP-AC-40] a working task with a live channel is never swept, however old the node looks', async () => {
    await agentTask('t_live_sweep', ATLAS, day(0), { state: 'working', channelId: 'ch_live_sweep', running: true });
    await db.collection('channels').insertOne({ channelId: 'ch_live_sweep', workspaceId: WS, running: true });
    await db.collection('todo_nodes').updateOne({ nodeId: 't_live_sweep' }, { $set: { updatedAt: Date.now() - 5 * 60 * 60 * 1000 } });

    await (svc as Any)._runPeriodicSchedule();

    // The zombie clean-up resets the stale node flag, but the live channel
    // keeps the task out of the sweep: a real turn is running on it.
    expect((await raw('t_live_sweep')).state).toBe('working');
  });

  it('[TODOAP-AC-40] a recent working task is not swept; a human working task is never swept', async () => {
    await runner(ATLAS, 1, true);
    // Recent agent task: below the timeout.
    await agentTask('t_recent', ATLAS, day(0), { state: 'working', running: false });
    // Human task, however old: out of scope (humans manage working by hand).
    await seed({
      nodeId: 't_human',
      state: 'working',
      assignee: { kind: 'user', id: 'user_pablo' },
      plannedFor: day(0),
      updatedAt: Date.now() - 5 * 60 * 60 * 1000,
    });

    await (svc as Any)._runPeriodicSchedule();

    expect((await raw('t_recent')).state).toBe('working');
    expect((await raw('t_human')).state).toBe('working');
  });
});

// =============================================================================
// Actions
// =============================================================================

describe('todo actions — runners', () => {
  it('[TODOAP-AC-2] get-autoplay lists runners with activeSlots = running tasks of the agent in the workspace', async () => {
    await runner(ATLAS, 3, true);
    await runner(BEA, 0, false);
    await agentTask('t_r1', ATLAS, day(0), { state: 'working', channelId: 'c1', running: true });
    await agentTask('t_r2', ATLAS, day(0), { state: 'review', channelId: 'c2', running: true });
    await agentTask('t_idle', ATLAS, day(0), { state: 'working', channelId: 'c3', running: false });
    await agentTask('t_other_ws', ATLAS, day(0), { workspaceId: OTHER_WS, state: 'working', channelId: 'c4', running: true });
    await runner(ATLAS, 9, true, OTHER_WS);

    const res = await call('get-autoplay', { callerUserId: READER });
    expect(res.runners).toEqual([
      { agentId: ATLAS, name: 'Atlas', avatarUrl: 'https://x/atlas.png', slots: 3, playEnabled: true, activeSlots: 2, ...NO_SCOPE },
      { agentId: BEA, name: 'Bea', avatarUrl: null, slots: 0, playEnabled: false, activeSlots: 0, ...NO_SCOPE },
    ]);
  });

  it('[TODOAP-AC-2] a runner view resolves the avatar like the member list: the core avatar, made absolute', async () => {
    await db.collection('agents').insertOne({ agentId: 'agent_nira', workspaceId: WS, name: 'Nira', coreId: 'core_nira' });
    await db.collection('agent_cores').insertOne({ coreId: 'core_nira', avatarUrl: 'cores/nira.png' });
    await runner('agent_nira', 1, true);

    const res = await call('get-autoplay', { callerUserId: READER });
    const nira = res.runners.find((r: { agentId: string }) => r.agentId === 'agent_nira');
    expect(nira.avatarUrl).toMatch(/^https?:\/\/.+\/cores\/nira\.png$/);
  });

  it('[TODOAP-AC-2] a runner change broadcasts todo_autoplay_changed to every member', async () => {
    const res = await call('set-agent-slots', { agentId: ATLAS, slots: 2, callerUserId: WRITER });
    expect(res.runner).toMatchObject({ agentId: ATLAS, slots: 2, playEnabled: false, activeSlots: 0 });
    expect(topicsOf('todo_autoplay_changed').sort()).toEqual([`todo:${OWNER}`, `todo:${READER}`, `todo:${WRITER}`]);
    const payload = pubSub.broadcastToTopic.mock.calls.find((c) => c[1]?.type === 'todo_autoplay_changed')![1];
    expect(payload).toEqual({ type: 'todo_autoplay_changed', workspaceId: WS, agentId: ATLAS, slots: 2, playEnabled: false, activeSlots: 0, ...NO_SCOPE });

    pubSub.broadcastToTopic.mockClear();
    await call('set-agent-play', { agentId: ATLAS, enabled: true, callerUserId: OWNER });
    expect(topicsOf('todo_autoplay_changed')).toHaveLength(3);

    pubSub.broadcastToTopic.mockClear();
    expect(await call('remove-agent', { agentId: ATLAS, callerUserId: WRITER })).toEqual({ removed: true, agentId: ATLAS });
    expect(await db.collection('todo_autoplay_runners').countDocuments({})).toBe(0);
    const removed = pubSub.broadcastToTopic.mock.calls.find((c) => c[1]?.type === 'todo_autoplay_changed')![1];
    expect(removed).toMatchObject({ agentId: ATLAS, removed: true });
  });

  it('[TODOAP-AC-1] set-agent-play with 0 slots fails INVALID_STATE (409)', async () => {
    const err = await failure('set-agent-play', { agentId: ATLAS, enabled: true, callerUserId: OWNER });
    expect(err).toMatchObject({ code: 'INVALID_STATE', status: 409 });
  });

  it('read members only list; outsiders and foreign agents are refused', async () => {
    expect(await failure('set-agent-slots', { agentId: ATLAS, slots: 1, callerUserId: READER })).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(await failure('remove-agent', { agentId: ATLAS, callerUserId: READER })).toMatchObject({ code: 'FORBIDDEN' });
    expect(await failure('set-agent-play', { agentId: ATLAS, enabled: false, callerUserId: 'user_invited' })).toMatchObject({ code: 'FORBIDDEN' });
    expect(await failure('set-agent-slots', { agentId: ATLAS, slots: 1 })).toMatchObject({ code: 'FORBIDDEN' });
    expect(await failure('set-agent-slots', { agentId: 'agent_foreign', slots: 1, callerUserId: OWNER })).toMatchObject({ code: 'INVALID_ASSIGNEE' });
    expect(await failure('set-agent-slots', { agentId: ATLAS, slots: -1, callerUserId: OWNER })).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await db.collection('todo_autoplay_runners').countDocuments({})).toBe(0);
  });

  it('set-agent-play (enable) runs the scheduling cycle', async () => {
    await call('set-agent-slots', { agentId: ATLAS, slots: 1, callerUserId: OWNER });
    await agentTask('t_go', ATLAS, day(0));
    await call('set-agent-play', { agentId: ATLAS, enabled: true, callerUserId: OWNER });
    await settle();
    expect((await raw('t_go')).state).toBe('working');
  });
});

// =============================================================================
// Global play/pause (TODOAP-REQ-30) — the panel's Play/Pause, separate from
// the per-runner config: a runner only works iff global=playing ∧
// playEnabled ∧ slots≥1. Alice disabled + Nira enabled → the global play
// starts ONLY Nira (Pablo's case, 2026-10-30).
// =============================================================================

describe('global play/pause', () => {
  it('[TODOAP-AC-41] get-autoplay reports globalPlaying (default playing, no doc); set-global-play persists and broadcasts it', async () => {
    // Default: no state doc → playing.
    expect(await call('get-autoplay', { callerUserId: READER })).toMatchObject({ globalPlaying: true });

    // Pause: the doc appears, the broadcast carries the global payload.
    pubSub.broadcastToTopic.mockClear();
    expect(await call('set-global-play', { playing: false, callerUserId: WRITER })).toEqual({ globalPlaying: false });
    expect(await call('get-autoplay', { callerUserId: READER })).toMatchObject({ globalPlaying: false });
    expect(topicsOf('todo_autoplay_changed').sort()).toEqual([`todo:${OWNER}`, `todo:${READER}`, `todo:${WRITER}`]);
    const payload = pubSub.broadcastToTopic.mock.calls.find((c) => c[1]?.type === 'todo_autoplay_changed')![1];
    expect(payload).toEqual({ type: 'todo_autoplay_changed', workspaceId: WS, globalPlaying: false });

    // Play: back to the default — the doc is gone.
    pubSub.broadcastToTopic.mockClear();
    expect(await call('set-global-play', { playing: true, callerUserId: OWNER })).toEqual({ globalPlaying: true });
    expect(await db.collection('todo_autoplay_state').countDocuments({ workspaceId: WS })).toBe(0);
    expect(pubSub.broadcastToTopic.mock.calls.find((c) => c[1]?.type === 'todo_autoplay_changed')![1]).toEqual({
      type: 'todo_autoplay_changed',
      workspaceId: WS,
      globalPlaying: true,
    });
  });

  it('[TODOAP-AC-41] the global pause stops the cycle: an enabled runner with slots starts nothing while paused; the play starts it', async () => {
    await runner(ATLAS, 1, true);
    await agentTask('t_g1', ATLAS, day(0));

    await call('set-global-play', { playing: false, callerUserId: OWNER });
    await svc.scheduleAgentTasks(WS, ATLAS);
    await settle();
    expect((await raw('t_g1')).state).toBe('pending');

    await call('set-global-play', { playing: true, callerUserId: OWNER });
    await settle();
    expect((await raw('t_g1')).state).toBe('working');
  });

  it("[TODOAP-AC-41] Pablo's case: Alice disabled + Nira enabled — the global play starts ONLY the enabled runner", async () => {
    const ALICE = 'agent_alice';
    const NIRA = 'agent_nira';
    await db.collection('agents').insertMany([
      { agentId: ALICE, workspaceId: WS, name: 'Alice' },
      { agentId: NIRA, workspaceId: WS, name: 'Nira' },
    ]);
    // Alice disabled (playEnabled false), Nira enabled — both with slots.
    await runner(ALICE, 2, false);
    await runner(NIRA, 2, true);
    await agentTask('t_alice', ALICE, day(0));
    await agentTask('t_nira', NIRA, day(0));

    // Globally paused, then play: only Nira's task starts.
    await call('set-global-play', { playing: false, callerUserId: OWNER });
    await call('set-global-play', { playing: true, callerUserId: OWNER });
    await settle();
    expect((await raw('t_nira')).state).toBe('working');
    expect((await raw('t_alice')).state).toBe('pending');

    // The Alice/Nira split is per-runner config, not the global state: with
    // the global playing, enabling Alice starts hers too.
    await call('set-agent-play', { agentId: ALICE, enabled: true, callerUserId: OWNER });
    await settle();
    expect((await raw('t_alice')).state).toBe('working');
  });

  it('[TODOAP-AC-41] the periodic safety net skips a paused workspace and serves a playing one', async () => {
    await runner(ATLAS, 1, true, WS);
    await runner(BEA, 1, true, OTHER_WS);
    await db.collection('todo_nodes').insertOne({
      parentId: null, workspaceId: OTHER_WS, nodeId: 't_other', text: 'other', description: '', instructions: '',
      completed: false, collapsed: false, position: 0, log: [], createdAt: Date.now(), updatedAt: Date.now(),
      kind: 'task', state: 'pending', assignee: { kind: 'agent', id: BEA }, assignedAt: 1, plannedFor: day(0), dayOrder: 0,
    });
    await agentTask('t_mine', ATLAS, day(0));

    // Pause only WS.
    await call('set-global-play', { playing: false, callerUserId: OWNER });
    await svc._runPeriodicScheduleForTest();
    await settle();
    expect((await raw('t_mine')).state).toBe('pending');
    expect((await db.collection('todo_nodes').findOne({ nodeId: 't_other' }))?.state).toBe('working');

    // Play WS again: the next cycle picks its task up.
    await call('set-global-play', { playing: true, callerUserId: OWNER });
    await svc._runPeriodicScheduleForTest();
    await settle();
    expect((await raw('t_mine')).state).toBe('working');
  });

  it('[TODOAP-AC-41] read members cannot change the global play; the state is per workspace', async () => {
    expect(await failure('set-global-play', { playing: false, callerUserId: READER })).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(await failure('set-global-play', { playing: false })).toMatchObject({ code: 'FORBIDDEN' });
    expect(await failure('set-global-play', { playing: 'yes', callerUserId: OWNER })).toMatchObject({ code: 'INVALID_INPUT' });
    // No state doc was written by the failed calls.
    expect(await db.collection('todo_autoplay_state').countDocuments({})).toBe(0);

    // OTHER_WS is untouched by WS's pause.
    await call('set-global-play', { playing: false, callerUserId: OWNER });
    expect(await svc.getGlobalPlay(OTHER_WS)).toBe(true);
  });

  it('[TODOAP-AC-42] get-autoplay reports runningCount; the STOP pauses AND aborts every in-flight turn of the workspace', async () => {
    // Two running tasks with live workers, one running without a worker, one
    // pending — and another workspace's running task that must be untouched.
    // The fake abort also clears the node's running flag, exactly what the
    // real turn's finally does after a worker abort (todo-running.ts).
    const aborts: string[] = [];
    const fakeRegistry = {
      get: (channelId: string) =>
        channelId === 'ch_live_1' || channelId === 'ch_live_2'
          ? {
              abort: mock(async (opts: Any) => {
                aborts.push(`${channelId}:${opts.kind}`);
                await db.collection('todo_nodes').updateOne({ channelId }, { $set: { running: false } });
              }),
            }
          : undefined,
      getOrCreate: () => { throw new Error('not used'); },
    };
    __setChannelWorkerRegistryForTests(fakeRegistry as Any);
    try {
      await runner(ATLAS, 4, true);
      await agentTask('t_live1', ATLAS, day(0), { state: 'working', channelId: 'ch_live_1', running: true });
      await agentTask('t_live2', ATLAS, day(0), { state: 'working', channelId: 'ch_live_2', running: true });
      await agentTask('t_noworker', ATLAS, day(0), { state: 'working', channelId: 'ch_gone', running: true });
      await agentTask('t_pend', ATLAS, day(0));
      await db.collection('todo_nodes').insertOne({
        parentId: null, workspaceId: OTHER_WS, nodeId: 't_other_run', text: 'other', description: '', instructions: '',
        completed: false, collapsed: false, position: 0, log: [], createdAt: Date.now(), updatedAt: Date.now(),
        kind: 'task', state: 'working', assignee: { kind: 'agent', id: BEA }, assignedAt: 1,
        channelId: 'ch_other_ws', running: true,
      });

      // runningCount: the three running tasks of WS (live or not).
      expect(await call('get-autoplay', { callerUserId: READER })).toMatchObject({ globalPlaying: true, runningCount: 3 });

      // STOP: pauses + soft-aborts the two live turns, skips the workerless
      // one, never touches the other workspace.
      const res = await call('stop-autoplay', { callerUserId: WRITER });
      expect(res).toEqual({ globalPlaying: false, aborted: 2 });
      expect(aborts.sort()).toEqual(['ch_live_1:soft', 'ch_live_2:soft']);
      expect(await svc.getGlobalPlay(WS)).toBe(false);
      expect(await svc.getGlobalPlay(OTHER_WS)).toBe(true);
      // The tasks stay working — coherent state, nothing restarted.
      expect((await raw('t_live1')).state).toBe('working');
      expect((await raw('t_noworker')).state).toBe('working');
      // The scheduler is stopped too: nothing new starts while stopped.
      await svc.scheduleAgentTasks(WS, ATLAS);
      await settle();
      expect((await raw('t_pend')).state).toBe('pending');

      // The play brings it all back: the cycle re-wakes the working ones.
      await call('set-global-play', { playing: true, callerUserId: OWNER });
      await settle();
      expect((await raw('t_pend')).state).toBe('working');
    } finally {
      __setChannelWorkerRegistryForTests(null as Any);
    }
  });

  it('[TODOAP-AC-42] stop-autoplay is writer-only and idempotent with nothing in flight', async () => {
    expect(await failure('stop-autoplay', { callerUserId: READER })).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    // Nothing running → zero aborts, still pauses.
    expect(await call('stop-autoplay', { callerUserId: OWNER })).toEqual({ globalPlaying: false, aborted: 0 });
    expect(await svc.getGlobalPlay(WS)).toBe(false);
    // A second stop is a no-op on the same state.
    expect(await call('stop-autoplay', { callerUserId: OWNER })).toEqual({ globalPlaying: false, aborted: 0 });
  });
});

describe('todo actions — scheduling triggers', () => {
  it('assign-node to an agent and plan-node run the cycle', async () => {
    await runner(ATLAS, 2, true);
    await seed({ nodeId: 't_assign', plannedFor: day(0), dayOrder: 0 });
    await call('assign-node', { nodeId: 't_assign', assignee: { kind: 'agent', id: ATLAS } });
    await settle();
    expect((await raw('t_assign')).state).toBe('working');

    await agentTask('t_plan', ATLAS, null);
    await call('plan-node', { nodeId: 't_plan', day: day(-1) });
    await settle();
    expect((await raw('t_plan')).state).toBe('working');
  });

  it('[TODOAP-REQ-8] set-state out of working clears running and a slot freed by review starts the next task', async () => {
    await runner(ATLAS, 1, true);
    await agentTask('t_w', ATLAS, day(0), { state: 'working', channelId: 'ch_w', running: true, autoWakeCount: 1 });
    await agentTask('t_next', ATLAS, day(0));
    const res = await call('set-state', { nodeId: 't_w', state: 'review' });
    expect(res.node).toMatchObject({ state: 'review', running: false, autoWakeCount: 0, channelId: 'ch_w' });
    await settle();
    expect((await raw('t_next')).state).toBe('working');
  });
});

// =============================================================================
// Runner scope — unassigned pickup (TODOAP-REQ-22)
// =============================================================================

/** A group node. */
function group(nodeId: string, parentId: string | null, text = nodeId, workspaceId = WS) {
  return seed({ nodeId, parentId, text, kind: 'group', state: undefined, workspaceId });
}

/** An unassigned pending task planned for `plannedFor`. */
function freeTask(nodeId: string, parentId: string | null, plannedFor: string | null, extra: Record<string, unknown> = {}) {
  return seed({ nodeId, parentId, plannedFor, dayOrder: plannedFor ? 0 : null, ...extra });
}

async function scopedRunner(agentId: string, slots: number, scopeNodeId: string | null, pickUnassigned: boolean) {
  await db.collection('todo_autoplay_runners').insertOne({
    workspaceId: WS,
    agentId,
    slots,
    playEnabled: true,
    scopeNodeId,
    pickUnassigned,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function logTexts(node: Any): string[] {
  return (node.log ?? []).map((e: Any) => e.text);
}

describe('TodoAutoplayService — runner scope', () => {
  it('[TODOAP-AC-30] picks up an unassigned task inside the scope after the own tasks, atomically; scope missing suspends the pickup', async () => {
    // Tree: G › G1 › u_in (depth 2) plus the decoys.
    await group('g', null, 'Garden');
    await group('g1', 'g', 'Beds');
    await freeTask('u_in', 'g1', day(0));
    await freeTask('u_out', null, day(0));
    await freeTask('u_planning', 'g1', day(-1), { state: 'planning' });
    await freeTask('u_tomorrow', 'g1', day(1));
    await seed({ nodeId: 'h_in', parentId: 'g1', assignee: { kind: 'user', id: WRITER }, assignedAt: 1, plannedFor: day(0), dayOrder: 0 });
    await agentTask('a_own', ATLAS, day(0));

    // pickUnassigned false: free slots, yet only the own task starts.
    await scopedRunner(ATLAS, 5, 'g', false);
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect((await raw('a_own')).state).toBe('working');
    expect(await raw('u_in')).toMatchObject({ state: 'pending' });
    expect((await raw('u_in')).assignee ?? null).toBeNull();

    // pickUnassigned true with one free slot: the own task outside G goes first.
    await db.collection('todo_nodes').updateOne({ nodeId: 'a_own' }, { $set: { running: true } });
    await agentTask('a_own2', ATLAS, day(0));
    await db.collection('todo_autoplay_runners').updateOne(
      { workspaceId: WS, agentId: ATLAS },
      { $set: { slots: 2, pickUnassigned: true } },
    );
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect((await raw('a_own2')).state).toBe('working');
    expect((await raw('u_in')).state).toBe('pending');
    expect((await raw('u_in')).assignee ?? null).toBeNull();

    // Next free slot: the unassigned task inside G is assigned, logged and started.
    await db.collection('todo_nodes').updateOne({ nodeId: 'a_own2' }, { $set: { running: true } });
    await db.collection('todo_autoplay_runners').updateOne({ workspaceId: WS, agentId: ATLAS }, { $set: { slots: 5 } });
    await svc.scheduleAgentTasks(WS, ATLAS);
    const picked = await raw('u_in');
    expect(picked).toMatchObject({ state: 'working', assignee: { kind: 'agent', id: ATLAS } });
    expect(typeof picked.assignedAt).toBe('number');
    expect(typeof picked.channelId).toBe('string');
    const texts = logTexts(picked);
    expect(texts).toContain('Autoplay: picked up by Atlas');
    expect(texts.indexOf('Autoplay: picked up by Atlas')).toBeLessThan(texts.indexOf('Autoplay: started by Atlas'));
    expect(wake.mock.calls.some((c) => c[0] === picked.channelId && c[1] === ATLAS)).toBe(true);

    // Outside G, planning, tomorrow and the human's task are left untouched.
    for (const id of ['u_out', 'u_planning', 'u_tomorrow', 'h_in']) {
      const n = await raw(id);
      expect(n.channelId).toBeUndefined();
      expect(logTexts(n)).toEqual([]);
    }
    expect((await raw('u_out')).assignee ?? null).toBeNull();
    expect((await raw('h_in')).assignee).toEqual({ kind: 'user', id: WRITER });
    let [view] = await svc.listRunners(WS);
    expect(view).toMatchObject({ scopeNodeId: 'g', scopePath: 'Garden', pickUnassigned: true, scopeMissing: false });

    // G turned into a task: nothing unassigned is picked; the view says scopeMissing.
    await freeTask('u_in2', 'g1', day(0));
    await db.collection('todo_nodes').updateOne({ nodeId: 'g' }, { $set: { kind: 'task', state: 'pending' } });
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect((await raw('u_in2')).state).toBe('pending');
    expect((await raw('u_out')).state).toBe('pending');
    [view] = await svc.listRunners(WS);
    expect(view).toMatchObject({ scopeNodeId: 'g', scopeMissing: true, scopePath: null });

    // G deleted: same.
    await db.collection('todo_nodes').deleteOne({ nodeId: 'g' });
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect((await raw('u_in2')).state).toBe('pending');
    expect((await raw('u_in2')).assignee ?? null).toBeNull();
    [view] = await svc.listRunners(WS);
    expect(view).toMatchObject({ scopeMissing: true });

    // Assigned tasks keep flowing while the scope is missing.
    await agentTask('a_own3', ATLAS, day(0));
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect((await raw('a_own3')).state).toBe('working');
  });

  it('[TODOAP-AC-30] two runners cycling over the same unassigned task result in exactly one assignment', async () => {
    await scopedRunner(ATLAS, 1, null, true);
    await scopedRunner(BEA, 1, null, true);
    await freeTask('u_shared', null, day(-1));
    await Promise.all([svc.scheduleAgentTasks(WS, ATLAS), svc.scheduleAgentTasks(WS, BEA)]);
    const n = await raw('u_shared');
    expect(n.state).toBe('working');
    expect([ATLAS, BEA]).toContain(n.assignee.id);
    expect(logTexts(n).filter((t) => t.startsWith('Autoplay: picked up by'))).toHaveLength(1);
    expect(logTexts(n).filter((t) => t.startsWith('Autoplay: started by'))).toHaveLength(1);
    expect(channelManager.createChannel).toHaveBeenCalledTimes(1);
  });

  it('[TODOAP-AC-36] the unassigned pickup follows the same key: planned day, day panel order, tree order', async () => {
    await scopedRunner(ATLAS, 1, null, true);
    // Inserted out of key order so the database's natural order cannot pass the test.
    await freeTask('u_d', null, day(0), { dayOrder: null, position: 1 });
    await freeTask('u_b', null, day(0), { dayOrder: 2, position: 3 });
    await freeTask('u_a', null, day(-1), { dayOrder: null, position: 50 });
    await freeTask('u_c', null, day(0), { dayOrder: 1, position: 4 });

    const picked: string[] = [];
    for (let cycle = 0; cycle < 4; cycle++) {
      await svc.scheduleAgentTasks(WS, ATLAS);
      const working = await db.collection('todo_nodes').find({ state: 'working' }).toArray();
      expect(working).toHaveLength(1);
      expect(working[0].assignee).toEqual({ kind: 'agent', id: ATLAS });
      picked.push(working[0].nodeId);
      await db.collection('todo_nodes').updateOne({ nodeId: working[0].nodeId }, { $set: { state: 'review' } });
    }
    expect(picked).toEqual(['u_a', 'u_c', 'u_b', 'u_d']);
  });
});

describe('todo actions — set-agent-scope', () => {
  it('[TODOAP-AC-31] persists a group scope and broadcasts its path; task or unknown ids fail INVALID_INPUT; null clears the path; read members are FORBIDDEN', async () => {
    await group('p', null, 'Home');
    await group('g', 'p', 'Garden');
    await freeTask('t_task', 'g', null);
    await group('g_foreign', null, 'Foreign', OTHER_WS);

    const res = await call('set-agent-scope', { agentId: ATLAS, scopeNodeId: 'g', pickUnassigned: true, callerUserId: WRITER });
    expect(res.runner).toMatchObject({ agentId: ATLAS, scopeNodeId: 'g', scopePath: 'Home › Garden', pickUnassigned: true, scopeMissing: false });
    expect(await db.collection('todo_autoplay_runners').findOne({ workspaceId: WS, agentId: ATLAS })).toMatchObject({
      scopeNodeId: 'g',
      pickUnassigned: true,
    });
    expect(topicsOf('todo_autoplay_changed').sort()).toEqual([`todo:${OWNER}`, `todo:${READER}`, `todo:${WRITER}`]);
    const payload = pubSub.broadcastToTopic.mock.calls.find((c) => c[1]?.type === 'todo_autoplay_changed')![1];
    expect(payload).toMatchObject({ workspaceId: WS, agentId: ATLAS, scopeNodeId: 'g', scopePath: 'Home › Garden', pickUnassigned: true });
    expect((await call('get-autoplay', { callerUserId: READER })).runners[0]).toMatchObject({ scopePath: 'Home › Garden' });

    for (const scopeNodeId of ['t_task', 'nope', 'g_foreign']) {
      expect(await failure('set-agent-scope', { agentId: ATLAS, scopeNodeId, pickUnassigned: true, callerUserId: OWNER })).toMatchObject({
        code: 'INVALID_INPUT',
        status: 400,
      });
    }
    expect(await db.collection('todo_autoplay_runners').findOne({ workspaceId: WS, agentId: ATLAS })).toMatchObject({ scopeNodeId: 'g' });

    const cleared = await call('set-agent-scope', { agentId: ATLAS, scopeNodeId: null, pickUnassigned: false, callerUserId: OWNER });
    expect(cleared.runner).toMatchObject({ scopeNodeId: null, scopePath: null, pickUnassigned: false, scopeMissing: false });

    expect(await failure('set-agent-scope', { agentId: ATLAS, scopeNodeId: 'g', pickUnassigned: true, callerUserId: READER })).toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    expect(await db.collection('todo_autoplay_runners').findOne({ workspaceId: WS, agentId: ATLAS })).toMatchObject({ scopeNodeId: null });
  });

  it('[TODOAP-REQ-22] set-agent-scope on a playing runner runs the cycle', async () => {
    await runner(ATLAS, 1, true);
    await group('g', null, 'Garden');
    await freeTask('u_go', 'g', day(0));
    await call('set-agent-scope', { agentId: ATLAS, scopeNodeId: 'g', pickUnassigned: true, callerUserId: OWNER });
    await settle();
    expect(await raw('u_go')).toMatchObject({ state: 'working', assignee: { kind: 'agent', id: ATLAS } });
  });

  it('[TODOAP-REQ-22] plan-node, set-state into pending and assign-node to nobody run the pickers of the workspace', async () => {
    await scopedRunner(ATLAS, 3, null, true);
    await freeTask('u_plan', null, null);
    await call('plan-node', { nodeId: 'u_plan', day: day(0) });
    await settle();
    expect((await raw('u_plan')).state).toBe('working');

    await freeTask('u_back', null, day(0), { state: 'planning' });
    await call('set-state', { nodeId: 'u_back', state: 'pending' });
    await settle();
    expect((await raw('u_back')).state).toBe('working');

    await seed({ nodeId: 'u_freed', assignee: { kind: 'user', id: WRITER }, assignedAt: 1, plannedFor: day(0), dayOrder: 0 });
    await call('assign-node', { nodeId: 'u_freed', assignee: null });
    await settle();
    expect(await raw('u_freed')).toMatchObject({ state: 'working', assignee: { kind: 'agent', id: ATLAS } });
  });
});

describe('todo actions — progress resets the re-wake count', () => {
  it('[TODOAP-AC-8] set-progress and add-log-entry reset autoWakeCount to 0', async () => {
    await agentTask('t_p', ATLAS, day(0), { state: 'working', autoWakeCount: 3 });
    await call('set-progress', { nodeId: 't_p', progress: 40 });
    expect((await raw('t_p')).autoWakeCount).toBe(0);
    await db.collection('todo_nodes').updateOne({ nodeId: 't_p' }, { $set: { autoWakeCount: 2 } });
    await call('add-log-entry', { nodeId: 't_p', text: 'halfway' });
    const node = await raw('t_p');
    expect(node.autoWakeCount).toBe(0);
    expect(node.log.at(-1).text).toBe('halfway');
  });
});

describe('todo actions — start-node', () => {
  it('[TODOAP-AC-10] starts a pending agent task with play off and no planned day; the caller is billed', async () => {
    await agentTask('t_manual', ATLAS, null);
    const res = await call('start-node', { nodeId: 't_manual', callerUserId: WRITER });
    expect(res.node).toMatchObject({ nodeId: 't_manual', state: 'working' });
    expect(res.channelId).toBe(res.node.channelId);
    expect(channelManager.createChannel.mock.calls[0][0]).toBe(WRITER);
    expect(channelManager.saveMessage.mock.calls[0][0]).toMatchObject({ userId: WRITER, sender: SYSTEM_SENDER });
    expect(wake.mock.calls[0][3]).toBe('autorun');
  });

  it('[TODOAP-AC-10] refuses human tasks with NOT_AGENT_TASK and other states with INVALID_STATE', async () => {
    await seed({ nodeId: 't_human', assignee: { kind: 'user', id: WRITER } });
    expect(await failure('start-node', { nodeId: 't_human', callerUserId: OWNER })).toMatchObject({ code: 'NOT_AGENT_TASK', status: 400 });
    await seed({ nodeId: 't_none' });
    expect(await failure('start-node', { nodeId: 't_none', callerUserId: OWNER })).toMatchObject({ code: 'NOT_AGENT_TASK' });
    await agentTask('t_review', ATLAS, null, { state: 'review' });
    expect(await failure('start-node', { nodeId: 't_review', callerUserId: OWNER })).toMatchObject({ code: 'INVALID_STATE', status: 409 });
    await agentTask('t_linked', ATLAS, null, { state: 'working', channelId: 'ch_x' });
    expect(await failure('start-node', { nodeId: 't_linked', callerUserId: OWNER })).toMatchObject({ code: 'INVALID_STATE' });
    // working without a conversation can be started
    await agentTask('t_orphan', ATLAS, null, { state: 'working' });
    expect((await call('start-node', { nodeId: 't_orphan', callerUserId: OWNER })).node.channelId).toBeTruthy();
  });

  it('[TODOAP-AC-15] start-node whose conversation cannot be created fails START_FAILED and rolls back', async () => {
    await agentTask('t_boom', ATLAS, null);
    channelManager.createChannel.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    expect(await failure('start-node', { nodeId: 't_boom', callerUserId: OWNER })).toMatchObject({ code: 'START_FAILED', status: 500 });
    const node = await raw('t_boom');
    expect(node.state).toBe('pending');
    expect(node.startFailCount).toBe(1);
    expect(node.log.at(-1).text).toBe(`Autoplay: start failed (attempt 1/${CAP}): boom`);
  });
});

describe('todo actions — reply to a blocked task', () => {
  // No runner here: the reply wakes the agent at once (TODOAP-REQ-24's no-runner branch).
  it('[TODOAP-AC-11] posts the reply in the conversation as the caller, wakes the agent and moves the task to working', async () => {
    await db.collection('channels').insertOne({ channelId: 'ch_b', workspaceId: WS, agentId: ATLAS });
    await agentTask('t_blocked', ATLAS, day(0), { state: 'blocked', blockedReason: 'Tax id?', channelId: 'ch_b', running: false });
    const res = await call('set-state', { nodeId: 't_blocked', state: 'working', reply: 'B-12345678', callerUserId: WRITER });
    expect(res.node).toMatchObject({ state: 'working', blockedReason: null });
    const saved = channelManager.saveMessage.mock.calls[0][0];
    expect(saved).toMatchObject({ channelId: 'ch_b', role: 'user', userId: WRITER, sender: { type: 'user', id: WRITER } });
    expect(saved.content.text).toBe('B-12345678');
    expect(wake).toHaveBeenCalledWith('ch_b', ATLAS, 'B-12345678', 'user_message');
    const logs = (await raw('t_blocked')).log.map((l: Any) => l.text);
    expect(logs).toEqual(['Reply: B-12345678', 'blocked → working']);
  });

  it('without a conversation it only logs and transitions; reply outside blocked → working is refused', async () => {
    await agentTask('t_b2', ATLAS, day(0), { state: 'blocked', blockedReason: 'q' });
    await call('set-state', { nodeId: 't_b2', state: 'working', reply: 'answer' });
    expect((await raw('t_b2')).log.map((l: Any) => l.text)).toEqual(['Reply: answer', 'blocked → working']);
    expect(channelManager.saveMessage).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect(await failure('set-state', { nodeId: 't_b2', state: 'review', reply: 'x' })).toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('todo actions — send back from review with a note', () => {
  // No runner here: the note wakes the agent at once (TODOAP-REQ-24's no-runner branch).
  it('[TODOAP-AC-28] logs "Sent back:", posts "Sent back from review:" and wakes the agent; without a conversation only logs; refused on review → done', async () => {
    await db.collection('channels').insertOne({ channelId: 'ch_r', workspaceId: WS, agentId: ATLAS });
    await agentTask('t_review', ATLAS, day(0), { state: 'review', channelId: 'ch_r', running: false });
    const res = await call('set-state', { nodeId: 't_review', state: 'working', reply: 'Missing the October invoice', callerUserId: WRITER });
    expect(res.node).toMatchObject({ state: 'working' });
    const saved = channelManager.saveMessage.mock.calls[0][0];
    expect(saved).toMatchObject({ channelId: 'ch_r', role: 'user', userId: WRITER });
    expect(saved.content.text).toBe('Sent back from review: Missing the October invoice');
    expect(wake).toHaveBeenCalledWith('ch_r', ATLAS, 'Sent back from review: Missing the October invoice', 'user_message');
    expect((await raw('t_review')).log.map((l: Any) => l.text)).toEqual(['Sent back: Missing the October invoice', 'review → working']);

    channelManager.saveMessage.mockClear();
    wake.mockClear();
    await agentTask('t_review2', ATLAS, day(0), { state: 'review' });
    const res2 = await call('set-state', { nodeId: 't_review2', state: 'working', reply: 'Missing the October invoice' });
    expect(res2.node).toMatchObject({ state: 'working' });
    expect((await raw('t_review2')).log.map((l: Any) => l.text)).toEqual(['Sent back: Missing the October invoice', 'review → working']);
    expect(channelManager.saveMessage).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();

    await agentTask('t_review3', ATLAS, day(0), { state: 'review' });
    expect(await failure('set-state', { nodeId: 't_review3', state: 'done', reply: 'x' })).toMatchObject({ code: 'INVALID_INPUT' });
    expect((await raw('t_review3')).state).toBe('review');
  });
});

describe('todo actions — replies and send-backs honour the runner\'s slots', () => {
  /**
   * One slot, busy on t_busy (a turn running); t_waiting (blocked or review,
   * with a conversation) and an eligible pending task. Returns after the reply.
   */
  async function replyWithBusyRunner(from: 'blocked' | 'review'): Promise<Any> {
    await runner(ATLAS, 1, true);
    await db.collection('channels').insertMany([
      { channelId: 'ch_busy', workspaceId: WS, agentId: ATLAS },
      { channelId: 'ch_wait', workspaceId: WS, agentId: ATLAS },
    ]);
    await agentTask('t_busy', ATLAS, day(-1), { state: 'working', channelId: 'ch_busy', running: true });
    await agentTask('t_waiting', ATLAS, day(-1), {
      state: from,
      ...(from === 'blocked' ? { blockedReason: 'Tax id?' } : {}),
      channelId: 'ch_wait',
      running: false,
      autoWakeCount: 1,
    });
    await agentTask('t_pending', ATLAS, day(0));
    return call('set-state', { nodeId: 't_waiting', state: 'working', reply: 'B-12345678', callerUserId: WRITER });
  }

  /** The busy task's turn ends in review; the turn end runs nothing, the next cycle re-wakes t_waiting. */
  async function busyTurnEndsThenCycle(): Promise<void> {
    await db.collection('todo_nodes').updateOne({ nodeId: 't_busy' }, { $set: { state: 'review' } });
    await updateTodoNodeRunning(db, svc, 'ch_busy', false);
    await settle();
    expect(wake).not.toHaveBeenCalled();
    await svc.scheduleAgentTasks(WS, ATLAS);
    expect(wake).toHaveBeenCalledTimes(1);
    const waiting = await raw('t_waiting');
    expect(wake).toHaveBeenCalledWith('ch_wait', ATLAS, buildTodoRewakeMessage(waiting), 'autorun');
    expect(waiting.autoWakeCount).toBe(1);
    expect((await raw('t_pending')).state).toBe('pending');
  }

  it('[TODOAP-AC-35] a reply to a blocked task with the one slot busy saves the message, leaves the task stuck and wakes nothing; the next cycle re-wakes it before the pending task', async () => {
    const res = await replyWithBusyRunner('blocked');
    await settle();
    expect(res.node).toMatchObject({ state: 'working', blockedReason: null });
    expect(channelManager.saveMessage).toHaveBeenCalledTimes(1);
    expect(channelManager.saveMessage.mock.calls[0][0]).toMatchObject({ channelId: 'ch_wait', role: 'user', userId: WRITER });
    expect(channelManager.saveMessage.mock.calls[0][0].content.text).toBe('B-12345678');
    const node = await raw('t_waiting');
    expect(node.state).toBe('working');
    expect(node.running).toBe(false);
    expect(node.autoWakeCount).toBe(0);
    expect(wake).not.toHaveBeenCalled();
    expect((await raw('t_pending')).state).toBe('pending');

    await busyTurnEndsThenCycle();
  });

  it('[TODOAP-AC-35] a send-back from review with the one slot busy does the same', async () => {
    const res = await replyWithBusyRunner('review');
    await settle();
    expect(res.node).toMatchObject({ state: 'working' });
    expect(channelManager.saveMessage).toHaveBeenCalledTimes(1);
    expect(channelManager.saveMessage.mock.calls[0][0].content.text).toBe('Sent back from review: B-12345678');
    const node = await raw('t_waiting');
    expect(node.state).toBe('working');
    expect(node.running).toBe(false);
    expect(node.autoWakeCount).toBe(0);
    expect(wake).not.toHaveBeenCalled();

    await busyTurnEndsThenCycle();
  });

  it('[TODOAP-AC-35] with a playing runner and a free slot, the reply\'s cycle re-wakes the task at once (autorun), never a user_message turn', async () => {
    await runner(ATLAS, 1, true);
    await db.collection('channels').insertOne({ channelId: 'ch_free', workspaceId: WS, agentId: ATLAS });
    await agentTask('t_free', ATLAS, day(-1), { state: 'blocked', blockedReason: 'q', channelId: 'ch_free', running: false });
    await call('set-state', { nodeId: 't_free', state: 'working', reply: 'answer', callerUserId: WRITER });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith('ch_free', ATLAS, buildTodoRewakeMessage(await raw('t_free')), 'autorun');
  });

  it('[TODOAP-AC-35] without a playing runner (paused or no slots) the reply wakes the agent at once with user_message', async () => {
    await runner(ATLAS, 1, false);
    await db.collection('channels').insertOne({ channelId: 'ch_np', workspaceId: WS, agentId: ATLAS });
    await agentTask('t_np', ATLAS, day(-1), { state: 'blocked', blockedReason: 'q', channelId: 'ch_np', running: false });
    await call('set-state', { nodeId: 't_np', state: 'working', reply: 'answer', callerUserId: WRITER });
    expect(channelManager.saveMessage).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith('ch_np', ATLAS, 'answer', 'user_message');

    wake.mockClear();
    await db.collection('todo_autoplay_runners').updateOne({ agentId: ATLAS }, { $set: { playEnabled: true, slots: 0 } });
    await agentTask('t_np2', ATLAS, day(-1), { state: 'review', channelId: 'ch_np', running: false });
    await call('set-state', { nodeId: 't_np2', state: 'working', reply: 'redo', callerUserId: WRITER });
    expect(wake).toHaveBeenCalledWith('ch_np', ATLAS, 'Sent back from review: redo', 'user_message');
  });
});

describe('todo actions — io shares (TODOOV)', () => {
  it('[TODOOV-AC-4] share-io returns a publicUrl and the same shareId again; get-io-share returns it; unshare-io removes it; a form output is INVALID_STATE; a read member is FORBIDDEN', async () => {
    await seed({ nodeId: 't_md', text: 'Write the report', output: { format: 'markdown', markdown: '# Report' } });
    await seed({ nodeId: 't_form', output: { format: 'form', fields: [{ id: 'a', type: 'text', label: 'A' }], values: {} } });
    await seed({ nodeId: 't_none' });

    const first = await call('share-io', { nodeId: 't_md', io: 'output', callerUserId: OWNER });
    expect(first.shareId).toMatch(/^[0-9a-f]{32}$/);
    expect(first.publicUrl).toBe(`${config.share.baseUrl}/share/${first.shareId}`);
    const again = await call('share-io', { nodeId: 't_md', io: 'output', callerUserId: OWNER });
    expect(again).toEqual(first);
    expect(await db.collection('shared_files').findOne({ shareId: first.shareId }, { projection: { _id: 0, createdAt: 0 } })).toEqual({
      shareId: first.shareId,
      ownerId: OWNER,
      workspaceId: WS,
      source: { kind: 'todo-io', workspaceId: WS, nodeId: 't_md', io: 'output' },
    });

    expect(await call('get-io-share', { nodeId: 't_md', io: 'output', callerUserId: OWNER })).toEqual(first);
    // Per caller and per io: another member and the input slot have no share.
    expect(await call('get-io-share', { nodeId: 't_md', io: 'output', callerUserId: WRITER })).toBeNull();
    expect(await call('get-io-share', { nodeId: 't_md', io: 'input', callerUserId: OWNER })).toBeNull();
    // Only the owner revokes.
    expect(await failure('unshare-io', { shareId: first.shareId, callerUserId: WRITER })).toMatchObject({ code: 'FORBIDDEN', status: 403 });

    expect(await call('unshare-io', { shareId: first.shareId, callerUserId: OWNER })).toEqual({ ok: true });
    expect(await call('get-io-share', { nodeId: 't_md', io: 'output', callerUserId: OWNER })).toBeNull();
    expect(await db.collection('shared_files').countDocuments({})).toBe(0);

    for (const [nodeId, io] of [['t_form', 'output'], ['t_none', 'output'], ['t_md', 'input']]) {
      expect(await failure('share-io', { nodeId, io, callerUserId: OWNER })).toMatchObject({ code: 'INVALID_STATE', status: 409 });
    }
    expect(await failure('share-io', { nodeId: 'nope', io: 'output', callerUserId: OWNER })).toMatchObject({ code: 'NOT_FOUND' });

    expect(await failure('share-io', { nodeId: 't_md', io: 'output', callerUserId: READER })).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(await failure('get-io-share', { nodeId: 't_md', io: 'output', callerUserId: READER })).toMatchObject({ code: 'FORBIDDEN' });
    expect(await failure('unshare-io', { shareId: 'x', callerUserId: READER })).toMatchObject({ code: 'FORBIDDEN' });
    expect(await db.collection('shared_files').countDocuments({})).toBe(0);
  });
});

describe('todo actions — expectedOutput', () => {
  it('[TODOAP-AC-16] update-node expectedOutput persists and is returned by reads; inconsistent definitions are rejected; null clears it', async () => {
    const node = (await call('add-node', { text: 'Report', state: 'pending', expectedOutput: { format: 'markdown' } })).node;
    expect(node.expectedOutput).toEqual({ format: 'markdown' });
    const def = {
      format: 'form',
      description: 'Customer data',
      fields: [
        { id: 'taxId', type: 'text', label: 'Tax id', required: true },
        { id: 'employees', type: 'number', label: 'Employees' },
      ],
    };
    const upd = await call('update-node', { nodeId: node.nodeId, expectedOutput: def });
    expect(upd.node.expectedOutput).toEqual(def);
    expect((await call('get-node', { nodeId: node.nodeId })).node.expectedOutput).toEqual(def);
    const tree = await call('get-tree', {});
    expect(tree.tree[0]).toMatchObject({ expectedOutput: def, channelId: null, running: false, autoWakeCount: 0 });

    for (const bad of [
      { format: 'file', fields: def.fields },
      { format: 'markdown', fileType: 'pdf' },
      { format: 'file', fileType: 'exe' },
      { format: 'pdf' },
      { format: 'markdown', description: 'x'.repeat(501) },
    ]) {
      expect(await failure('update-node', { nodeId: node.nodeId, expectedOutput: bad })).toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect((await call('get-node', { nodeId: node.nodeId })).node.expectedOutput).toEqual(def);

    const cleared = await call('update-node', { nodeId: node.nodeId, expectedOutput: null });
    expect(cleared.node.expectedOutput).toBeNull();
    expect((await call('get-node', { nodeId: node.nodeId })).node.expectedOutput).toBeNull();

    const html = await call('update-node', { nodeId: node.nodeId, expectedOutput: { format: 'file', fileType: 'html' } });
    expect(html.node.expectedOutput).toEqual({ format: 'file', fileType: 'html' });
    expect((await call('get-node', { nodeId: node.nodeId })).node.expectedOutput).toEqual({ format: 'file', fileType: 'html' });

    const group = (await call('add-node', { text: 'G', kind: 'group' })).node;
    expect(await failure('update-node', { nodeId: group.nodeId, expectedOutput: { format: 'file' } })).toMatchObject({ code: 'NOT_A_TASK' });
  });
});

describe('todo actions — set-output against the expected output', () => {
  const agentApps = config.agentApps as { objectStoragePath: string };
  const OBJ_PATH = join(tmpdir(), `teros-todo-autoplay-obj-${Date.now()}`);
  let previousObjectPath: string;

  beforeAll(() => {
    previousObjectPath = agentApps.objectStoragePath;
    agentApps.objectStoragePath = OBJ_PATH;
  });

  afterAll(async () => {
    agentApps.objectStoragePath = previousObjectPath;
    await rm(OBJ_PATH, { recursive: true, force: true });
  });

  const file = (name: string, mime: string) => ({ format: 'file', name, mime, data: Buffer.from('x').toString('base64') });
  const formOut = (ids: string[]) => ({
    format: 'form',
    fields: ids.map((id) => ({ id, type: 'text', label: id })),
    values: {},
  });

  it('[TODOAP-AC-18] a form output must carry the required fields and nothing outside the definition', async () => {
    const node = (await call('add-node', {
      text: 'Customer',
      state: 'pending',
      expectedOutput: {
        format: 'form',
        fields: [
          { id: 'taxId', type: 'text', label: 'Tax id', required: true },
          { id: 'notes', type: 'text', label: 'Notes' },
        ],
      },
    })).node;
    const missing = await failure('set-output', { nodeId: node.nodeId, output: formOut(['notes']) });
    expect(missing).toMatchObject({ code: 'OUTPUT_MISMATCH', status: 400 });
    expect(missing.message).toContain('"taxId"');
    const extra = await failure('set-output', { nodeId: node.nodeId, output: formOut(['taxId', 'phone']) });
    expect(extra).toMatchObject({ code: 'OUTPUT_MISMATCH' });
    expect(extra.message).toContain('"phone"');
    expect((await raw(node.nodeId)).output).toBeNull();
    const ok = await call('set-output', { nodeId: node.nodeId, output: formOut(['taxId']) });
    expect(ok.node.output).toMatchObject({ format: 'form' });
  });

  it('[TODOAP-AC-18] a file output must be of the expected type; a markdown output on a file definition fails', async () => {
    const node = (await call('add-node', {
      text: 'Invoice',
      state: 'pending',
      expectedOutput: { format: 'file', fileType: 'pdf' },
    })).node;
    const png = await failure('set-output', { nodeId: node.nodeId, output: file('invoice.png', 'image/png') });
    expect(png).toMatchObject({ code: 'OUTPUT_MISMATCH' });
    expect(png.message).toContain('pdf');
    const md = await failure('set-output', { nodeId: node.nodeId, output: { format: 'markdown', markdown: 'hi' } });
    expect(md).toMatchObject({ code: 'OUTPUT_MISMATCH' });
    expect(md.message).toContain('expected format "file", got "markdown"');
    const ok = await call('set-output', { nodeId: node.nodeId, output: file('invoice.pdf', 'application/pdf') });
    expect(ok.node.output).toMatchObject({ format: 'file', name: 'invoice.pdf' });
  });

  it('[TODOAP-AC-18] an html file output matches by .html/.htm extension or text/html mime; a pdf does not', async () => {
    const node = (await call('add-node', {
      text: 'Report page',
      state: 'pending',
      expectedOutput: { format: 'file', fileType: 'html' },
    })).node;
    const pdf = await failure('set-output', { nodeId: node.nodeId, output: file('report.pdf', 'application/pdf') });
    expect(pdf).toMatchObject({ code: 'OUTPUT_MISMATCH' });
    expect(pdf.message).toContain('html');
    expect((await raw(node.nodeId)).output).toBeNull();
    const byExt = await call('set-output', { nodeId: node.nodeId, output: file('report.html', 'application/octet-stream') });
    expect(byExt.node.output).toMatchObject({ format: 'file', name: 'report.html' });
    const htm = await call('set-output', { nodeId: node.nodeId, overwrite: true, output: file('report.HTM', 'application/octet-stream') });
    expect(htm.node.output).toMatchObject({ format: 'file', name: 'report.HTM' });
    const byMime = await call('set-output', { nodeId: node.nodeId, overwrite: true, output: file('report.out', 'text/html; charset=utf-8') });
    expect(byMime.node.output).toMatchObject({ format: 'file', name: 'report.out', mime: 'text/html; charset=utf-8' });
  });

  it('[TODOAP-AC-20] the Fill in shape (definition fields, empty values) is accepted with required fields unfilled; a later save with values too', async () => {
    const fields = [
      { id: 'taxId', type: 'text', label: 'Tax id', required: true },
      { id: 'checked', type: 'checkbox', label: 'Checked', required: true },
    ];
    const node = (await call('add-node', {
      text: 'Checklist',
      state: 'pending',
      expectedOutput: { format: 'form', fields },
    })).node;
    const empty = await call('set-output', { nodeId: node.nodeId, output: { format: 'form', fields, values: {} } });
    expect(empty.node.output).toMatchObject({ format: 'form', values: {} });
    const blank = await call('set-output', {
      nodeId: node.nodeId,
      output: { format: 'form', fields, values: { taxId: '', checked: false } },
    });
    expect(blank.node.output.values).toEqual({ taxId: '', checked: false });
    const filled = await call('set-output', {
      nodeId: node.nodeId,
      output: { format: 'form', fields, values: { taxId: 'B123', checked: true } },
    });
    expect(filled.node.output.values).toEqual({ taxId: 'B123', checked: true });
    expect((await raw(node.nodeId)).state).toBe('pending');
  });

  it('[TODOAP-AC-22] set-output stamps outputUpdatedAt and logs only meaningful output changes', async () => {
    const fields = [
      { id: 'taxId', type: 'text', label: 'Tax id', required: true },
      { id: 'checked', type: 'checkbox', label: 'Checked' },
    ];
    const node = (await call('add-node', { text: 'Fill', state: 'working', expectedOutput: { format: 'form', fields } })).node;
    const logs = async () => (await raw(node.nodeId)).log.map((l: Any) => l.text);
    expect((await call('get-node', { nodeId: node.nodeId })).node.outputUpdatedAt).toBeNull();

    const before = Date.now();
    const first = await call('set-output', { nodeId: node.nodeId, output: { format: 'form', fields, values: {} } });
    expect(first.node.outputUpdatedAt).toBeGreaterThanOrEqual(before);
    expect(await logs()).toEqual(['Output delivered · form']);

    await new Promise((r) => setTimeout(r, 5));
    const valuesOnly = await call('set-output', {
      nodeId: node.nodeId,
      overwrite: true,
      output: { format: 'form', fields: [...fields].reverse(), values: { taxId: 'B1', checked: true } },
    });
    expect(valuesOnly.node.outputUpdatedAt).toBeGreaterThan(first.node.outputUpdatedAt);
    expect(await logs()).toEqual(['Output delivered · form']);
    const stamp = valuesOnly.node.outputUpdatedAt;
    expect((await call('get-node', { nodeId: node.nodeId })).node.outputUpdatedAt).toBe(stamp);
    expect((await call('get-tree', {})).tree.find((n: Any) => n.nodeId === node.nodeId).outputUpdatedAt).toBe(stamp);
    await call('plan-node', { nodeId: node.nodeId, day: '2026-10-27' });
    const dayRes = await call('get-day', { day: '2026-10-27' });
    expect(JSON.stringify(dayRes)).toContain(`"outputUpdatedAt":${stamp}`);

    // A field-id change logs.
    await call('set-output', { nodeId: node.nodeId, overwrite: true, output: { format: 'form', fields: [fields[0]], values: { taxId: 'B1' } } });
    expect((await logs()).filter((t: string) => t.startsWith('Output'))).toHaveLength(2);

    // In review every save logs.
    await call('set-state', { nodeId: node.nodeId, state: 'review' });
    await call('set-output', { nodeId: node.nodeId, overwrite: true, output: { format: 'form', fields: [fields[0]], values: { taxId: 'B2' } } });
    expect((await logs()).filter((t: string) => t.startsWith('Output'))).toHaveLength(3);

    // Clearing logs and stamps too.
    const cleared = await call('set-output', { nodeId: node.nodeId, output: null });
    expect(cleared.node.outputUpdatedAt).toBeGreaterThanOrEqual(stamp);
    expect((await logs()).at(-1)).toBe('Output cleared');

    // Markdown and file outputs in working: a changed text or a replaced file logs, the same text does not.
    const other = (await call('add-node', { text: 'Write', state: 'working' })).node;
    const otherLogs = async () => (await raw(other.nodeId)).log.filter((l: Any) => l.text.startsWith('Output')).length;
    await call('set-output', { nodeId: other.nodeId, output: { format: 'markdown', markdown: 'v1' } });
    expect(await otherLogs()).toBe(1);
    await call('set-output', { nodeId: other.nodeId, output: { format: 'markdown', markdown: 'v1' } });
    expect(await otherLogs()).toBe(1);
    await call('set-output', { nodeId: other.nodeId, overwrite: true, output: { format: 'markdown', markdown: 'v2' } });
    expect(await otherLogs()).toBe(2);
    const pdf = { format: 'file', name: 'a.pdf', mime: 'application/pdf', data: Buffer.from('x').toString('base64') };
    await call('set-output', { nodeId: other.nodeId, overwrite: true, output: pdf });
    expect(await otherLogs()).toBe(3);
    // Every upload stores a new object, so re-sending the same file is a replacement and logs.
    await call('set-output', { nodeId: other.nodeId, overwrite: true, output: pdf });
    expect(await otherLogs()).toBe(4);
  });

  it('without an expected output any format is accepted', async () => {
    const node = (await call('add-node', { text: 'Free', state: 'pending' })).node;
    const ok = await call('set-output', { nodeId: node.nodeId, output: { format: 'markdown', markdown: 'done' } });
    expect(ok.node.output).toMatchObject({ format: 'markdown' });
  });
});

// =============================================================================
// Log actors (docs/specs/todo/log-actor.md, TODOLG)
// =============================================================================

describe('todo log actors (TODOLG)', () => {
  const NIRA = 'agent_nira';
  // The MCA callback URL's segment is the app id, so ctx.channelId is the app, never a conversation.
  const fromApp: McaActionCtx = { ...ctx, channelId: APP };
  // What the thin client forwards when Nira calls from her conversation (OWNER is the billing user).
  const asNira = { callerUserId: OWNER, callerAgentId: NIRA, callerChannelId: 'ch_nira' };

  function entry(node: Any, text: string): Any {
    return (node.log ?? []).find((e: Any) => e.text === text);
  }

  it('[TODOLG-AC-1] set-state, add-log-entry, the autoplay start and the pickup log their actor; get-node returns it', async () => {
    await db.collection('agents').insertOne({ agentId: NIRA, workspaceId: WS, name: 'Nira' });

    // A person in the window: callerUserId → the user.
    await seed({ nodeId: 't_user', state: 'pending' });
    await call('set-state', { nodeId: 't_user', state: 'working', callerUserId: 'user_1' });
    expect(entry(await raw('t_user'), 'pending → working').actor).toEqual({ kind: 'user', id: 'user_1' });

    // The same action from Nira (callerAgentId): the agent, even with a callerUserId
    // (there it is the billing user the thin client fills in, not the actor).
    await seed({ nodeId: 't_agent', state: 'pending' });
    await todoCapability.actions['set-state'](fromApp, db, { nodeId: 't_agent', state: 'working', ...asNira });
    expect(entry(await raw('t_agent'), 'pending → working').actor).toEqual({ kind: 'agent', id: NIRA });

    // add-log-entry from Nira: the agent.
    await todoCapability.actions['add-log-entry'](fromApp, db, { nodeId: 't_agent', text: 'Drafted the intro', ...asNira });
    expect(entry(await raw('t_agent'), 'Drafted the intro').actor).toEqual({ kind: 'agent', id: NIRA });

    // An unknown callerAgentId (no such agent, or another workspace's) is ignored: the caller user wins.
    await seed({ nodeId: 't_ghost', state: 'pending' });
    await todoCapability.actions['set-state'](fromApp, db, {
      nodeId: 't_ghost', state: 'working', callerUserId: 'user_1', callerAgentId: 'agent_ghost',
    });
    await todoCapability.actions['add-log-entry'](fromApp, db, {
      nodeId: 't_ghost', text: 'Foreign note', callerUserId: 'user_1', callerAgentId: 'agent_foreign',
    });
    const ghost = await raw('t_ghost');
    expect(entry(ghost, 'pending → working').actor).toEqual({ kind: 'user', id: 'user_1' });
    expect(entry(ghost, 'Foreign note').actor).toEqual({ kind: 'user', id: 'user_1' });

    // add-log-entry and set-progress from the window (no channel, callerUserId set): the user.
    await call('add-log-entry', { nodeId: 't_user', text: 'Checked the copy', callerUserId: 'user_1' });
    await call('set-progress', { nodeId: 't_user', progress: 60, callerUserId: 'user_1' });
    const windowed = await raw('t_user');
    expect(entry(windowed, 'Checked the copy').actor).toEqual({ kind: 'user', id: 'user_1' });
    expect(entry(windowed, 'Progress 60%').actor).toEqual({ kind: 'user', id: 'user_1' });

    // The scheduler: the pickup is the agent's, the start and the link are the system's.
    await freeTask('u_pick', null, day(0));
    await scopedRunner(ATLAS, 1, null, true);
    await svc.scheduleAgentTasks(WS, ATLAS);
    const picked = await raw('u_pick');
    expect(picked.state).toBe('working');
    expect(entry(picked, 'Autoplay: picked up by Atlas').actor).toEqual({ kind: 'agent', id: ATLAS });
    expect(entry(picked, 'Autoplay: started by Atlas').actor).toEqual({ kind: 'system' });
    expect(entry(picked, 'Linked conversation').actor).toEqual({ kind: 'system' });

    // get-node returns the actor with each entry.
    const got = await call('get-node', { nodeId: 't_agent' });
    expect(got.node.log.map((e: Any) => ({ text: e.text, actor: e.actor }))).toEqual([
      { text: 'pending → working', actor: { kind: 'agent', id: NIRA } },
      { text: 'Drafted the intro', actor: { kind: 'agent', id: NIRA } },
    ]);
  });

  it('an action with neither calling agent nor caller logs the system; legacy entries stay without actor (TODOLG-REQ-1)', async () => {
    await seed({ nodeId: 't_sys', state: 'pending', log: [{ timestamp: 1, text: 'old line' }] });
    await call('set-progress', { nodeId: 't_sys', progress: 40 });
    const node = await raw('t_sys');
    expect(entry(node, 'Progress 40%').actor).toEqual({ kind: 'system' });
    expect(entry(node, 'old line').actor).toBeUndefined();
    const got = await call('get-node', { nodeId: 't_sys' });
    expect(got.node.log[0]).toEqual({ timestamp: 1, text: 'old line' });
  });
});
