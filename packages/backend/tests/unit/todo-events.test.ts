/**
 * Unit tests — to-do list events & subscriptions (todo/events spec).
 *
 * Covers the board-parity event system end to end against a real MongoDB:
 *   - subscribe-to-todo / unsubscribe-from-todo / list-todo-subscriptions
 *     (upsert semantics, channel resolution, workspace membership).
 *   - event emission: every mutation fires its todo.* event with the right
 *     payload (created/started/completed/blocked/assigned/planned/output/
 *     progress/updated/moved/deleted).
 *   - delivery: a subscribed channel receives a ScheduledEvent with
 *     wakeUpAgent and the event metadata (the "avísame cuando ESTA tarea
 *     termine" acceptance case).
 *   - filters: nodeIds, states, groupNodeIds (subtree scope), wakeUpOn.
 *   - self-wake guard data: actorAgentId rides the payload.
 *   - bus publishing: setTodoBusDispatch receives todo.<type> topics.
 */

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'bun:test';
import { type Db, MongoClient } from 'mongodb';
import { handleMcaAction, setMcaActionDeps, getMcaActionDeps, type McaActionCtx } from '../../src/mca-actions';
import { todoCapability } from '../../src/mca-actions/todo';
import { TodoSubscriptionService, type ScheduledEventLike } from '../../src/services/todo-subscription-service';
import { setTodoBusDispatch, type TodoBusDispatchFn } from '../../src/services/todo-event-emitters';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = `teros_todo_events_test_${Date.now()}`;

const MCA_ID = 'mca.teros.todo-list';
const WS = 'ws_todo_ev_1';
const OTHER_WS = 'ws_todo_ev_2';
const APP = 'app_todo_ev_1';
const CH = 'ch_sub_1';
const CH2 = 'ch_sub_2';
const USER = 'user_owner';
const AGENT = 'agent_watcher';

let client: MongoClient;
let db: Db;
let svc: TodoSubscriptionService;
let injected: Array<{ channelId: string; event: any }> = [];
let busEvents: Array<{ topic: string; payload: Record<string, unknown> }> = [];
let previousDeps: Record<string, unknown> = {};
let previousBus: TodoBusDispatchFn | null = null;

const ctx: McaActionCtx = { mcaId: MCA_ID, appId: APP };

type Any = any;

async function call(action: string, body: Record<string, unknown> = {}): Promise<Any> {
  return todoCapability.actions[action](ctx, db, body);
}

/**
 * Wait for the fire-and-forget event delivery to settle. notifySubscribers
 * never blocks its caller (board parity), so a test that mutates and
 * immediately asserts races the dispatch. Flushing the microtask queue plus a
 * few macrotask ticks covers the DB round-trips inside the dispatch.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function add(text: string, extra: Record<string, unknown> = {}): Promise<Any> {
  const { state, kind, ...rest } = extra as { state?: string; kind?: string };
  const body = kind === 'group' ? { text, kind, ...rest } : { text, state: state ?? 'pending', ...rest };
  return (await call('add-node', body)).node;
}

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  db = client.db(DB_NAME);
});

afterAll(async () => {
  await db.dropDatabase();
  await client.close();
});

beforeEach(async () => {
  for (const col of ['todo_nodes', 'todo_subscriptions', 'apps', 'channels', 'workspaces', 'workspace_members', 'agents']) {
    await db.collection(col).deleteMany({});
  }
  await db.collection('apps').insertOne({ appId: APP, mcaId: MCA_ID, ownerId: WS });
  await db.collection('workspaces').insertOne({ workspaceId: WS, ownerId: USER, name: 'WS', status: 'active' });
  await db.collection('channels').insertMany([
    { channelId: CH, userId: USER, workspaceId: WS, agentId: AGENT },
    { channelId: CH2, userId: USER, workspaceId: WS },
  ]);
  await db.collection('agents').insertOne({ agentId: AGENT, workspaceId: WS, name: 'Watcher' });

  svc = new TodoSubscriptionService(db);
  await settle();
  injected = [];
  busEvents = [];
  svc.setEventInjector(async (event) => {
    injected.push({ channelId: event.channelId, event });
    return { success: true };
  });
  previousDeps = { ...getMcaActionDeps() } as Record<string, unknown>;
  setMcaActionDeps({ todoSubscriptions: svc } as any);
  previousBus = null;
});

afterEach(async () => {
  setMcaActionDeps(previousDeps as any);
  setTodoBusDispatch(previousBus);
});

/** The bus publisher capture, mirroring server-bootstrap's wiring. */
function captureBus(): void {
  setTodoBusDispatch(async (event) => {
    busEvents.push(event);
  });
}

// =============================================================================
// Subscription CRUD
// =============================================================================

describe('todo events — subscribe/unsubscribe/list', () => {
  it('subscribes the calling agent channel with a filter', async () => {
    const res = await call('subscribe-to-todo', {
      callerUserId: USER,
      callerAgentId: AGENT,
      callerChannelId: CH,
      filter: { nodeIds: ['tn_x'], eventTypes: ['task_completed'] },
    });
    expect(res.created).toBe(true);
    expect(res.subscription.channelId).toBe(CH);
    expect(res.subscription.agentId).toBe(AGENT);
    expect(res.subscription.filter.nodeIds).toEqual(['tn_x']);
    expect(res.subscription.filter.eventTypes).toEqual(['task_completed']);
  });

  it('subscribing again REPLACES the filter (upsert, board parity)', async () => {
    await call('subscribe-to-todo', { callerUserId: USER, callerChannelId: CH, filter: { states: ['done'] } });
    const res = await call('subscribe-to-todo', { callerUserId: USER, callerChannelId: CH, filter: { nodeIds: ['tn_y'] } });
    expect(res.created).toBe(false);
    expect(res.subscription.filter.nodeIds).toEqual(['tn_y']);
    expect(res.subscription.filter.states).toBeUndefined();
    const list = await call('list-todo-subscriptions', { callerUserId: USER, callerChannelId: CH });
    expect(list.subscriptions).toHaveLength(1);
  });

  it('rejects an unknown channel and a non-member caller', async () => {
    const missing = await call('subscribe-to-todo', { callerUserId: USER, channelId: 'ch_ghost' }).catch((e: Any) => e);
    expect(missing.code).toBe('NOT_FOUND');
    const outsider = await call('subscribe-to-todo', { callerUserId: 'user_stranger', callerChannelId: CH }).catch((e: Any) => e);
    expect(outsider.code).toBe('FORBIDDEN');
  });

  it('unsubscribe is idempotent and scopes to the workspace', async () => {
    await call('subscribe-to-todo', { callerUserId: USER, callerChannelId: CH });
    const res = await call('unsubscribe-from-todo', { callerUserId: USER, callerChannelId: CH });
    expect(res.unsubscribed).toBe(true);
    expect(res.deleted).toBe(true);
    const again = await call('unsubscribe-from-todo', { callerUserId: USER, callerChannelId: CH });
    expect(again.deleted).toBe(false);
  });
});

// =============================================================================
// Event emission + delivery (the acceptance case)
// =============================================================================

describe('todo events — emission and delivery', () => {
  it('PABLO CASE: subscribe to a task completing → the channel is woken with the event', async () => {
    const task = await add('Informe de costes');
    await call('subscribe-to-todo', {
      callerUserId: USER,
      callerAgentId: AGENT,
      callerChannelId: CH,
      filter: { nodeIds: [task.nodeId], eventTypes: ['task_completed'] },
    });
    await settle();
    injected = [];

    await call('set-state', { nodeId: task.nodeId, state: 'working', callerUserId: USER });
    // started does not pass the filter — nothing delivered
    await settle();
    expect(injected).toHaveLength(0);

    await call('set-state', { nodeId: task.nodeId, state: 'done', callerUserId: USER });
    await settle();
    expect(injected).toHaveLength(1);
    await settle();
    const { channelId, event } = injected[0];
    expect(channelId).toBe(CH);
    expect(event.wakeUpAgent).toBe(true);
    expect(event.metadata.todoEventType).toBe('task_completed');
    expect(event.metadata.nodeId).toBe(task.nodeId);
    expect(event.metadata.state).toBe('done');
    expect(String(event.message)).toContain('Informe de costes');
  });

  it('emits task_created / task_started / task_blocked with payloads', async () => {
    captureBus();
    await call('subscribe-to-todo', { callerUserId: USER, callerChannelId: CH });
    await settle();
    injected = [];

    const task = await add('Nueva tarea', { callerUserId: USER });
    await call('set-state', { nodeId: task.nodeId, state: 'working', callerUserId: USER });
    await call('set-state', { nodeId: task.nodeId, state: 'blocked', reason: 'falta API key', callerUserId: USER });

    await settle();
    const types = injected.map((i) => i.event.metadata.todoEventType);
    expect(types).toEqual(['task_created', 'task_started', 'task_blocked']);
    await settle();
    const blocked = injected[2].event.metadata;
    expect(blocked.reason).toBe('falta API key');
    expect(blocked.fromState).toBe('working');

    // Bus topics mirror the conversation events (todo.* namespace).
    await settle();
    const topics = busEvents.map((b) => b.topic);
    expect(topics).toContain('todo.task_created');
    expect(topics).toContain('todo.task_started');
    expect(topics).toContain('todo.task_blocked');
    await settle();
    const busBlocked = busEvents.find((b) => b.topic === 'todo.task_blocked')!;
    expect(busBlocked.payload.workspaceId).toBe(WS);
    expect(busBlocked.payload.occurredAt).toBeDefined();
  });

  it('emits task_output_delivered and carries the output reference on completion', async () => {
    await call('subscribe-to-todo', { callerUserId: USER, callerChannelId: CH });
    const task = await add('Con output');
    await call('set-state', { nodeId: task.nodeId, state: 'working', callerUserId: USER });
    await settle();
    injected = [];

    await call('set-output', { nodeId: task.nodeId, output: { format: 'markdown', markdown: '# Resultado' }, callerUserId: USER });
    await settle();
    expect(injected[0].event.metadata.todoEventType).toBe('task_output_delivered');
    await settle();
    expect(injected[0].event.metadata.outputFormat).toBe('markdown');

    await settle();
    injected = [];
    await call('set-state', { nodeId: task.nodeId, state: 'review', callerUserId: USER });
    await settle();
    const completed = injected[0].event.metadata;
    expect(completed.todoEventType).toBe('task_completed');
    expect(completed.state).toBe('review');
    expect(completed.outputFormat).toBe('markdown');
  });

  it('emits assigned / unassigned / planned / progress / updated / moved / deleted', async () => {
    await call('subscribe-to-todo', { callerUserId: USER, callerChannelId: CH });
    const task = await add('Multi');
    const group = (await call('add-node', { text: 'G', kind: 'group' })).node;
    await settle();
    injected = [];

    await call('assign-node', { nodeId: task.nodeId, assignee: { kind: 'agent', id: AGENT }, callerUserId: USER });
    await call('plan-node', { nodeId: task.nodeId, day: '2026-11-02', time: '09:30', callerUserId: USER });
    await call('set-progress', { nodeId: task.nodeId, progress: 40, callerUserId: USER });
    await call('add-log-entry', { nodeId: task.nodeId, text: 'nota de progreso', callerUserId: USER });
    await call('update-node', { nodeId: task.nodeId, text: 'Multi v2', callerUserId: USER });
    await call('move-node', { nodeId: task.nodeId, newParentId: group.nodeId, newPosition: 0, callerUserId: USER });
    await call('delete-node', { nodeId: task.nodeId, callerUserId: USER });

    await settle();
    const types = injected.map((i) => i.event.metadata.todoEventType);
    expect(types).toEqual([
      'task_assigned',
      'task_planned',
      'task_progress',
      'task_progress',
      'task_updated',
      'task_moved',
      'task_deleted',
    ]);
    await settle();
    const planned = injected[1].event.metadata;
    expect(planned.day).toBe('2026-11-02');
    expect(planned.plannedTime).toBe('09:30');
    await settle();
    const progress = injected[2].event.metadata;
    expect(progress.progress).toBe(40);
    await settle();
    const note = injected[3].event.metadata;
    expect(note.noteText).toBe('nota de progreso');
    await settle();
    const moved = injected[5].event.metadata;
    expect(moved.parentText).toBe('G');
  });

  it('toggle-complete emits task_completed (done) and state_changed (reopen)', async () => {
    await call('subscribe-to-todo', { callerUserId: USER, callerChannelId: CH });
    const task = await add('Checkbox');
    await settle();
    injected = [];
    await call('toggle-complete', { nodeId: task.nodeId, callerUserId: USER });
    await settle();
    expect(injected[0].event.metadata.todoEventType).toBe('task_completed');
    await settle();
    expect(injected[0].event.metadata.state).toBe('done');

    await settle();
    injected = [];
    await call('toggle-complete', { nodeId: task.nodeId, callerUserId: USER });
    await settle();
    expect(injected[0].event.metadata.todoEventType).toBe('task_state_changed');
    await settle();
    expect(injected[0].event.metadata.fromState).toBe('done');
    await settle();
    expect(injected[0].event.metadata.state).toBe('pending');
  });

  it('actorAgentId rides the payload for the self-wake guard', async () => {
    await call('subscribe-to-todo', { callerUserId: USER, callerChannelId: CH });
    const task = await add('Actor');
    await settle();
    injected = [];
    await call('set-state', { nodeId: task.nodeId, state: 'working', callerUserId: USER, callerAgentId: AGENT });
    await settle();
    expect(injected[0].event.metadata.actorAgentId).toBe(AGENT);
    await settle();
    expect(injected[0].event.metadata.actorUserId).toBeUndefined();
  });
});

// =============================================================================
// Filters
// =============================================================================

describe('todo events — filters', () => {
  it('nodeIds filter only delivers events of those tasks', async () => {
    const a = await add('A');
    const b = await add('B');
    await call('subscribe-to-todo', { callerUserId: USER, callerChannelId: CH, filter: { nodeIds: [a.nodeId] } });
    await settle();
    injected = [];
    await call('set-state', { nodeId: b.nodeId, state: 'working', callerUserId: USER });
    await settle();
    expect(injected).toHaveLength(0);
    await call('set-state', { nodeId: a.nodeId, state: 'working', callerUserId: USER });
    await settle();
    expect(injected).toHaveLength(1);
  });

  it('states filter matches the NEW state', async () => {
    const a = await add('A');
    await call('subscribe-to-todo', { callerUserId: USER, callerChannelId: CH, filter: { states: ['blocked'] } });
    await settle();
    injected = [];
    await call('set-state', { nodeId: a.nodeId, state: 'working', callerUserId: USER });
    await settle();
    expect(injected).toHaveLength(0);
    await call('set-state', { nodeId: a.nodeId, state: 'blocked', reason: 'x', callerUserId: USER });
    await settle();
    expect(injected).toHaveLength(1);
  });

  it('groupNodeIds filter scopes to a group subtree', async () => {
    const group = (await call('add-node', { text: 'Proyecto', kind: 'group' })).node;
    const inside = (await call('add-node', { text: 'dentro', parentId: group.nodeId, state: 'pending' })).node;
    const outside = await add('fuera');
    await call('subscribe-to-todo', { callerUserId: USER, callerChannelId: CH, filter: { groupNodeIds: [group.nodeId] } });
    await settle();
    injected = [];
    await call('set-state', { nodeId: outside.nodeId, state: 'working', callerUserId: USER });
    await settle();
    expect(injected).toHaveLength(0);
    await call('set-state', { nodeId: inside.nodeId, state: 'working', callerUserId: USER });
    await settle();
    expect(injected).toHaveLength(1);
  });

  it('wakeUpOn narrows which events wake the agent', async () => {
    const a = await add('A');
    await call('subscribe-to-todo', {
      callerUserId: USER,
      callerChannelId: CH,
      filter: { wakeUpOn: ['task_completed'] },
    });
    await settle();
    injected = [];
    await call('set-state', { nodeId: a.nodeId, state: 'working', callerUserId: USER });
    await settle();
    expect(injected).toHaveLength(1);
    await settle();
    expect(injected[0].event.wakeUpAgent).toBe(false);
    await call('set-state', { nodeId: a.nodeId, state: 'done', callerUserId: USER });
    await settle();
    expect(injected[1].event.wakeUpAgent).toBe(true);
  });

  it('reviewerIds filter matches the task reviewer (TODORV), and task_completed carries the reviewer fields', async () => {
    const a = await add('A');
    const b = await add('B');
    await call('set-reviewer', { nodeId: a.nodeId, reviewer: { kind: 'agent', id: AGENT }, callerUserId: USER });
    await call('subscribe-to-todo', {
      callerUserId: USER,
      callerChannelId: CH,
      filter: { reviewerIds: [AGENT], eventTypes: ['task_completed'] },
    });
    await settle();
    injected = [];
    // B has no reviewer: its completion does not pass the filter.
    await call('set-state', { nodeId: b.nodeId, state: 'working', callerUserId: USER });
    await call('set-state', { nodeId: b.nodeId, state: 'review', callerUserId: USER });
    await settle();
    expect(injected).toHaveLength(0);
    // A has the reviewer: entering review passes, and the payload names them.
    await call('set-state', { nodeId: a.nodeId, state: 'working', callerUserId: USER });
    await call('set-state', { nodeId: a.nodeId, state: 'review', callerUserId: USER });
    await settle();
    expect(injected).toHaveLength(1);
    const payload = injected[0].event.metadata;
    expect(payload.reviewerKind).toBe('agent');
    expect(payload.reviewerId).toBe(AGENT);
    expect(payload.state).toBe('review');
  });

  it('events of another workspace are not delivered (tenancy)', async () => {
    await db.collection('apps').insertOne({ appId: 'app_other_ws', mcaId: MCA_ID, ownerId: OTHER_WS });
    const otherCtx: McaActionCtx = { mcaId: MCA_ID, appId: 'app_other_ws' };
    await db.collection('todo_nodes').insertOne({
      nodeId: 'tn_other_ws',
      parentId: null,
      workspaceId: OTHER_WS,
      text: 'otro ws',
      description: '',
      instructions: '',
      completed: false,
      collapsed: false,
      position: 0,
      log: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      kind: 'task',
      state: 'pending',
    });
    await call('subscribe-to-todo', { callerUserId: USER, callerChannelId: CH });
    await settle();
    injected = [];
    await todoCapability.actions['set-state'](otherCtx, db, { nodeId: 'tn_other_ws', state: 'working', callerUserId: USER });
    await settle();
    expect(injected).toHaveLength(0);
  });
});

// =============================================================================
// Dispatcher shape (handleMcaAction integration)
// =============================================================================

describe('todo events — dispatcher', () => {
  it('dispatches todo/subscribe-to-todo with status codes', async () => {
    const res = await handleMcaAction(ctx, db, 'todo/subscribe-to-todo', {
      callerUserId: USER,
      callerChannelId: CH,
    });
    expect(res.status).toBe(200);
    const body = res.body as Any;
    expect(body.subscription.channelId).toBe(CH);

    const bad = await handleMcaAction(ctx, db, 'todo/subscribe-to-todo', {
      callerUserId: 'user_stranger',
      callerChannelId: CH,
    });
    expect(bad.status).toBe(403);
  });
});
