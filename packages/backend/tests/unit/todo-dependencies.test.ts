/**
 * Unit tests — todo dependencies (TODODEP — Option A "ver y respetar",
 * Pablo 2-nov; the product plan's acceptance criteria):
 *   - add/remove-dependency: workspace scope, groups rejected both ways,
 *     idempotent adds, log entries;
 *   - cycles: self, direct and transitive all rejected with
n *     CIRCULAR_DEPENDENCY (board parity — a stored cycle is impossible);
 *   - release semantics: done and cancelled release, review does NOT
 *     (board parity); reopening a released blocker blocks again;
 *   - cleanup: delete purges every reference (zero orphans), cancel clears
 *     the task's own wait list, set-kind task→group drops dependencies;
 *   - reads: get-node/get-tree/get-day expose blockStatus + blockers with
 *     state + dependents (the inverse), with the board's semáforo semantics
 *     (red = some blocker not started, orange = started but unreleased,
 *     green = all released / none);
 *   - autoplay gate (startableTasks): a waiting task is not started and the
 *     reason names the blocker; a released one is; stuck re-wakes are not
 *     gated (in-flight work is never interrupted);
 *   - events: todo.dependency_added / todo.dependency_removed.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Db, MongoClient } from 'mongodb';
import { config } from '../../src/config';
// The capability registry first: todo.ts imports McaActionError from it, so
// loading todo.ts on its own would hit the registry's circular import.
import {
  handleMcaAction,
  setMcaActionDeps,
  getMcaActionDeps,
  type McaActionCtx,
} from '../../src/mca-actions';
import { startableTasks, todoCapability } from '../../src/mca-actions/todo';
import { TodoSubscriptionService } from '../../src/services/todo-subscription-service';
import { setTodoBusDispatch, type TodoBusDispatchFn } from '../../src/services/todo-event-emitters';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = `teros_todo_deps_test_${Date.now()}`;
const OBJ_PATH = join(tmpdir(), `todo-deps-objects-${Date.now()}`);

const MCA_ID = 'mca.teros.todo-list';
const WS = 'ws_dep_1';
const OTHER_WS = 'ws_dep_2';
const APP = 'app_dep_1';
const OTHER_APP = 'app_dep_2';
const USER = 'user_dep_owner';
const AGENT = 'agent_dep_watcher';
const CH = 'ch_dep_sub_1';

let client: MongoClient;
let db: Db;
const agentApps = config.agentApps as { objectStoragePath: string };
let previousObjectPath: string;
let svc: TodoSubscriptionService;
let injected: Array<{ channelId: string; event: any }> = [];
let busEvents: Array<{ topic: string; payload: Record<string, unknown> }> = [];
let previousDeps: Record<string, unknown> = {};
let previousBus: TodoBusDispatchFn | null = null;

const ctx: McaActionCtx = { mcaId: MCA_ID, appId: APP };
const otherCtx: McaActionCtx = { mcaId: MCA_ID, appId: OTHER_APP };

type Any = any;

async function call(action: string, body: Record<string, unknown> = {}, c: McaActionCtx = ctx): Promise<Any> {
  return todoCapability.actions[action](c, db, body);
}

async function failure(action: string, body: Record<string, unknown> = {}, c: McaActionCtx = ctx): Promise<Any> {
  try {
    await call(action, body, c);
  } catch (err) {
    return err;
  }
  throw new Error(`${action} was expected to fail`);
}

async function add(text: string, extra: Record<string, unknown> = {}, c: McaActionCtx = ctx): Promise<Any> {
  const { state, kind, ...rest } = extra as { state?: string; kind?: string };
  const body =
    kind === 'group'
      ? { text, kind, ...rest }
      : { text, state: state ?? 'pending', ...rest };
  return (await call('add-node', body, c)).node;
}

async function raw(nodeId: string): Promise<Any> {
  return db.collection('todo_nodes').findOne({ nodeId }, { projection: { _id: 0 } });
}

async function lastLog(nodeId: string): Promise<string | undefined> {
  const n = await raw(nodeId);
  return n.log.at(-1)?.text;
}

async function dep(nodeId: string, blockerNodeId: string): Promise<Any> {
  return call('add-dependency', { nodeId, blockerNodeId });
}

/** Flush the fire-and-forget event delivery (todo-events test pattern). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The bus publisher capture, mirroring server-bootstrap's wiring. */
function captureBus(): void {
  setTodoBusDispatch(async (event) => {
    busEvents.push(event);
  });
}

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  db = client.db(DB_NAME);
  previousObjectPath = agentApps.objectStoragePath;
  agentApps.objectStoragePath = OBJ_PATH;
});

afterAll(async () => {
  agentApps.objectStoragePath = previousObjectPath;
  await db.dropDatabase();
  await client.close();
  await fs.rm(OBJ_PATH, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const col of ['todo_nodes', 'todo_subscriptions', 'apps', 'channels', 'agent_app_objects', 'workspaces', 'workspace_members', 'agents', 'users']) {
    await db.collection(col).deleteMany({});
  }
  await db.collection('apps').insertMany([
    { appId: APP, mcaId: MCA_ID, ownerId: WS },
    { appId: OTHER_APP, mcaId: MCA_ID, ownerId: OTHER_WS },
  ]);
  await db.collection('workspaces').insertOne({ workspaceId: WS, ownerId: USER, name: 'WS', status: 'active' });
  await db.collection('channels').insertOne({ channelId: CH, userId: USER, workspaceId: WS, agentId: AGENT });
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

// =============================================================================
// add-dependency / remove-dependency
// =============================================================================

describe('todo — dependencies: add/remove', () => {
  it('adds a dependency, logs it and exposes the inverse on the blocker', async () => {
    const a = await add('A');
    const b = await add('B');
    const res = await dep(a.nodeId, b.nodeId);
    expect(res.added).toBe(true);
    expect(res.dependency).toMatchObject({ nodeId: b.nodeId, text: 'B', state: 'pending' });
    expect((await raw(a.nodeId)).dependencies).toEqual([b.nodeId]);
    expect(await lastLog(a.nodeId)).toBe('Depends on B');

    const blocker = await call('get-node', { nodeId: b.nodeId });
    expect(blocker.node.dependents).toEqual([{ nodeId: a.nodeId, text: 'A', state: 'pending' }]);
    expect(blocker.node.blockStatus).toBe('green'); // the blocker itself waits on nothing
  });

  it('is idempotent: adding the same dependency twice changes nothing', async () => {
    const a = await add('A');
    const b = await add('B');
    expect((await dep(a.nodeId, b.nodeId)).added).toBe(true);
    const again = await dep(a.nodeId, b.nodeId);
    expect(again.added).toBe(false);
    expect((await raw(a.nodeId)).dependencies).toEqual([b.nodeId]);
  });

  it('removes a dependency, logs it and is a no-op when absent', async () => {
    const a = await add('A');
    const b = await add('B');
    await dep(a.nodeId, b.nodeId);
    const res = await call('remove-dependency', { nodeId: a.nodeId, blockerNodeId: b.nodeId });
    expect(res.removed).toBe(true);
    expect(res.dependency).toMatchObject({ nodeId: b.nodeId, text: 'B' });
    expect((await raw(a.nodeId)).dependencies).toEqual([]);
    expect(await lastLog(a.nodeId)).toBe('Dependency removed: B');

    const none = await call('remove-dependency', { nodeId: a.nodeId, blockerNodeId: b.nodeId });
    expect(none.removed).toBe(false);
    expect(none.dependency).toBe(null);
  });

  it('groups can neither wait nor block (NOT_A_TASK)', async () => {
    const g = await add('G', { kind: 'group' });
    const t = await add('T');
    const asWaiter = await failure('add-dependency', { nodeId: g.nodeId, blockerNodeId: t.nodeId });
    expect(asWaiter.code).toBe('NOT_A_TASK');
    const asBlocker = await failure('add-dependency', { nodeId: t.nodeId, blockerNodeId: g.nodeId });
    expect(asBlocker.code).toBe('NOT_A_TASK');
    expect(asBlocker.message).toContain('group');
  });

  it('a blocker of another workspace is not found (cross-workspace is impossible)', async () => {
    const mine = await add('Mine');
    const foreign = await add('Foreign', {}, otherCtx);
    const err = await failure('add-dependency', { nodeId: mine.nodeId, blockerNodeId: foreign.nodeId });
    expect(err.code).toBe('NOT_FOUND');
    expect((await raw(mine.nodeId)).dependencies ?? []).toEqual([]);
  });

  it('dependencies work across groups (whole-tree scope, not same-parent)', async () => {
    const g1 = await add('G1', { kind: 'group' });
    const g2 = await add('G2', { kind: 'group' });
    const a = await add('A', { parentId: g1.nodeId });
    const b = await add('B', { parentId: g2.nodeId });
    expect((await dep(a.nodeId, b.nodeId)).added).toBe(true);
    expect((await raw(a.nodeId)).dependencies).toEqual([b.nodeId]);
  });

  it('is dispatched as todo/<action> with the domain code and status', async () => {
    const a = await add('A');
    const err: Any = await handleMcaAction(ctx, db, 'todo/add-dependency', { nodeId: a.nodeId, blockerNodeId: 'tn_missing' });
    expect(err.status).toBe(404);
    expect(err.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});

// =============================================================================
// Cycles
// =============================================================================

describe('todo — dependencies: cycles are impossible', () => {
  it('rejects a self dependency with a clear error', async () => {
    const a = await add('A');
    const err = await failure('add-dependency', { nodeId: a.nodeId, blockerNodeId: a.nodeId });
    expect(err.code).toBe('CIRCULAR_DEPENDENCY');
    expect(err.message).toContain('circular');
    expect((await raw(a.nodeId)).dependencies ?? []).toEqual([]);
  });

  it('rejects a direct cycle (A→B then B→A)', async () => {
    const a = await add('A');
    const b = await add('B');
    await dep(a.nodeId, b.nodeId);
    const err = await failure('add-dependency', { nodeId: b.nodeId, blockerNodeId: a.nodeId });
    expect(err.code).toBe('CIRCULAR_DEPENDENCY');
    expect(err.message).toContain('already depends');
    expect((await raw(b.nodeId)).dependencies ?? []).toEqual([]);
  });

  it('rejects a transitive cycle (A→B→C then C→A)', async () => {
    const a = await add('A');
    const b = await add('B');
    const c = await add('C');
    await dep(a.nodeId, b.nodeId);
    await dep(b.nodeId, c.nodeId);
    const err = await failure('add-dependency', { nodeId: c.nodeId, blockerNodeId: a.nodeId });
    expect(err.code).toBe('CIRCULAR_DEPENDENCY');
    expect((await raw(c.nodeId)).dependencies ?? []).toEqual([]);
  });

  it('a defensive cycle written straight to Mongo reads as circular (board parity)', async () => {
    const a = await add('A');
    const b = await add('B');
    await db.collection('todo_nodes').updateOne({ nodeId: a.nodeId }, { $set: { dependencies: [b.nodeId] } });
    await db.collection('todo_nodes').updateOne({ nodeId: b.nodeId }, { $set: { dependencies: [a.nodeId] } });
    const tree = await call('get-tree', {});
    const flat = JSON.stringify(tree.tree);
    expect(flat).toContain('circular');
    const node = await call('get-node', { nodeId: a.nodeId });
    expect(node.node.blockStatus).toBe('circular');
  });
});

// =============================================================================
// Release semantics (Option A: done/cancelled release; review does NOT)
// =============================================================================

describe('todo — dependencies: release semantics', () => {
  it('red while the blocker has not started, orange while working, green when done', async () => {
    const a = await add('A');
    const b = await add('B');
    await dep(a.nodeId, b.nodeId);

    expect((await call('get-node', { nodeId: a.nodeId })).node.blockStatus).toBe('red'); // pending blocker
    await call('set-state', { nodeId: b.nodeId, state: 'working' });
    expect((await call('get-node', { nodeId: a.nodeId })).node.blockStatus).toBe('orange');
    await call('set-state', { nodeId: b.nodeId, state: 'done' });
    expect((await call('get-node', { nodeId: a.nodeId })).node.blockStatus).toBe('green');
  });

  it('review does NOT release (board parity) — still orange', async () => {
    const a = await add('A');
    const b = await add('B');
    await dep(a.nodeId, b.nodeId);
    await call('set-state', { nodeId: b.nodeId, state: 'working' });
    await call('set-state', { nodeId: b.nodeId, state: 'review' });
    expect((await call('get-node', { nodeId: a.nodeId })).node.blockStatus).toBe('orange');
    // done releases:
    await call('set-state', { nodeId: b.nodeId, state: 'done' });
    expect((await call('get-node', { nodeId: a.nodeId })).node.blockStatus).toBe('green');
  });

  it('cancelled releases (green) and reopening the blocker blocks again', async () => {
    const a = await add('A');
    const b = await add('B');
    await dep(a.nodeId, b.nodeId);
    await call('set-state', { nodeId: b.nodeId, state: 'cancelled' });
    expect((await call('get-node', { nodeId: a.nodeId })).node.blockStatus).toBe('green');

    await call('set-state', { nodeId: b.nodeId, state: 'pending' }); // reopen
    expect((await call('get-node', { nodeId: a.nodeId })).node.blockStatus).toBe('red');
  });

  it('a cancelled task waits on nothing; reopening restores the wait', async () => {
    const a = await add('A');
    const b = await add('B');
    const c = await add('C');
    await dep(a.nodeId, b.nodeId);
    await dep(a.nodeId, c.nodeId);
    await call('set-state', { nodeId: a.nodeId, state: 'cancelled' });
    expect((await raw(a.nodeId)).dependencies).toEqual([]);

    await call('set-state', { nodeId: a.nodeId, state: 'pending' }); // reopen: clean
    expect((await raw(a.nodeId)).dependencies).toEqual([]);
  });

  it('one released + one pending blocker stays red (the strongest signal wins)', async () => {
    const a = await add('A');
    const done = await add('Done');
    const pending = await add('Pending');
    await dep(a.nodeId, done.nodeId);
    await dep(a.nodeId, pending.nodeId);
    await call('set-state', { nodeId: done.nodeId, state: 'done' });
    expect((await call('get-node', { nodeId: a.nodeId })).node.blockStatus).toBe('red');
  });

  it('toggle-complete (the checkbox shortcut) releases dependents too', async () => {
    const a = await add('A');
    const b = await add('B');
    await dep(a.nodeId, b.nodeId);
    await call('toggle-complete', { nodeId: b.nodeId });
    expect((await call('get-node', { nodeId: a.nodeId })).node.blockStatus).toBe('green');
  });
});

// =============================================================================
// Cleanup (zero orphans)
// =============================================================================

describe('todo — dependencies: cleanup', () => {
  it('deleting a blocker purges every reference to it (no orphans)', async () => {
    const a = await add('A');
    const b = await add('B');
    const c = await add('C');
    await dep(a.nodeId, b.nodeId);
    await dep(c.nodeId, b.nodeId);
    await call('delete-node', { nodeId: b.nodeId });

    expect((await raw(a.nodeId)).dependencies).toEqual([]);
    expect((await raw(c.nodeId)).dependencies).toEqual([]);
    // Reads agree: a missing blocker is ignored, not waited on.
    expect((await call('get-node', { nodeId: a.nodeId })).node.blockStatus).toBe('green');
    expect((await call('get-node', { nodeId: a.nodeId })).node.blockers).toEqual([]);
  });

  it('deleting a subtree purges references to every gone node', async () => {
    const g = await add('G', { kind: 'group' });
    const b1 = await add('B1', { parentId: g.nodeId });
    const b2 = await add('B2', { parentId: g.nodeId });
    const a = await add('A');
    await dep(a.nodeId, b1.nodeId);
    await dep(a.nodeId, b2.nodeId);
    await call('delete-node', { nodeId: g.nodeId });
    expect((await raw(a.nodeId)).dependencies).toEqual([]);
  });

  it('deleting the WAITING task leaves the blocker untouched (the inverse survives)', async () => {
    const a = await add('A');
    const b = await add('B');
    await dep(a.nodeId, b.nodeId);
    await call('delete-node', { nodeId: a.nodeId });
    expect((await raw(b.nodeId)).dependencies ?? []).toEqual([]);
    const blocker = await call('get-node', { nodeId: b.nodeId });
    expect(blocker.node.dependents).toEqual([]);
  });

  it('set-kind task→group drops its dependencies (a group waits on nothing)', async () => {
    const a = await add('A');
    const b = await add('B');
    await dep(a.nodeId, b.nodeId);
    await call('set-kind', { nodeId: a.nodeId, kind: 'group' });
    const doc = await raw(a.nodeId);
    expect(doc.dependencies).toBeUndefined();
    const bNode = await call('get-node', { nodeId: b.nodeId });
    expect(bNode.node.dependents).toEqual([]);
  });
});

// =============================================================================
// Reads: blockStatus + blockers + dependents everywhere
// =============================================================================

describe('todo — dependencies: reads', () => {
  it('get-tree exposes dependencies/blockStatus/blockers/dependents per node', async () => {
    const a = await add('A');
    const b = await add('B');
    await dep(a.nodeId, b.nodeId);
    const tree = await call('get-tree', {});
    const aRow = tree.tree.find((n: Any) => n.nodeId === a.nodeId);
    const bRow = tree.tree.find((n: Any) => n.nodeId === b.nodeId);
    expect(aRow).toMatchObject({
      dependencies: [b.nodeId],
      blockStatus: 'red',
      blockers: [{ nodeId: b.nodeId, text: 'B', state: 'pending' }],
      dependents: [],
    });
    expect(bRow).toMatchObject({ dependencies: [], blockStatus: 'green', dependents: [{ nodeId: a.nodeId, text: 'A' }] });
  });

  it('get-day exposes the same fields on every row', async () => {
    const TODAY = '2026-11-02';
    const a = await add('A');
    const b = await add('B');
    await dep(a.nodeId, b.nodeId);
    await call('plan-node', { nodeId: a.nodeId, day: TODAY });
    await call('plan-node', { nodeId: b.nodeId, day: TODAY });
    const day = await call('get-day', { day: TODAY, today: TODAY });
    const aRow = day.tasks.find((t: Any) => t.nodeId === a.nodeId);
    expect(aRow).toMatchObject({ blockStatus: 'red', dependencies: [b.nodeId] });
    expect(aRow.blockers[0]).toMatchObject({ text: 'B', state: 'pending' });
  });

  it('get-node exposes the full picture: blockers with state + the inverse', async () => {
    const a = await add('A');
    const b = await add('B');
    await dep(a.nodeId, b.nodeId);
    const res = await call('get-node', { nodeId: a.nodeId });
    expect(res.node).toMatchObject({
      dependencies: [b.nodeId],
      blockStatus: 'red',
      blockers: [{ nodeId: b.nodeId, text: 'B', state: 'pending' }],
      dependents: [],
    });
  });

  it('a task without dependencies reads exactly as before (zero noise)', async () => {
    const plain = await add('Plain');
    const res = await call('get-node', { nodeId: plain.nodeId });
    expect(res.node.dependencies).toEqual([]);
    expect(res.node.blockStatus).toBe('green');
    expect(res.node.blockers).toEqual([]);
    expect(res.node.dependents).toEqual([]);
  });
});

// =============================================================================
// Autoplay gate (startableTasks) — the "respetar" half of Option A
// =============================================================================

describe('todo — dependencies: autoplay gate (startableTasks)', () => {
  /**
   * The gate must see the CURRENT doc: the creation summary goes stale the
   * moment a dependency is added, so every test re-reads the node first.
   */
  async function fresh(nodeId: string): Promise<Any> {
    return (await call('get-node', { nodeId })).node;
  }

  it('a waiting task is not startable and the reason names the blocker with its state', async () => {
    const a = await add('A');
    const b = await add('B');
    await dep(a.nodeId, b.nodeId);

    const { startable, waiting } = await startableTasks(db, WS, [await fresh(a.nodeId), await fresh(b.nodeId)]);
    expect(startable.map((n: Any) => n.nodeId)).toEqual([b.nodeId]);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].node.nodeId).toBe(a.nodeId);
    expect(waiting[0].reason).toContain('"B" (pending)');
  });

  it('a released blocker makes the task startable (done and cancelled both release)', async () => {
    const a = await add('A');
    const b = await add('B');
    await dep(a.nodeId, b.nodeId);
    await call('set-state', { nodeId: b.nodeId, state: 'done' });
    const doneGate = await startableTasks(db, WS, [await fresh(a.nodeId), await fresh(b.nodeId)]);
    expect(doneGate.waiting).toEqual([]);
    expect(doneGate.startable.map((n: Any) => n.nodeId)).toContain(a.nodeId);

    const c = await add('C');
    const d = await add('D');
    await dep(c.nodeId, d.nodeId);
    await call('set-state', { nodeId: d.nodeId, state: 'cancelled' });
    const cancelledGate = await startableTasks(db, WS, [await fresh(c.nodeId), await fresh(d.nodeId)]);
    expect(cancelledGate.waiting).toEqual([]);
    expect(cancelledGate.startable.map((n: Any) => n.nodeId)).toContain(c.nodeId);
  });

  it('review does NOT release for autoplay either (board parity)', async () => {
    const a = await add('A');
    const b = await add('B');
    await dep(a.nodeId, b.nodeId);
    await call('set-state', { nodeId: b.nodeId, state: 'working' });
    await call('set-state', { nodeId: b.nodeId, state: 'review' });
    const gate = await startableTasks(db, WS, [await fresh(a.nodeId), await fresh(b.nodeId)]);
    expect(gate.waiting.map((w: Any) => w.node.nodeId)).toEqual([a.nodeId]);
    expect(gate.startable.map((n: Any) => n.nodeId)).toEqual([b.nodeId]);
  });

  it('a missing blocker (deleted) never waits — the task stays startable', async () => {
    const a = await add('A');
    const b = await add('B');
    await dep(a.nodeId, b.nodeId);
    // Simulate a stale reference (the actions purge on delete; this is the
    // defensive path if a raw write ever left one behind).
    await db.collection('todo_nodes').updateOne(
      { nodeId: a.nodeId },
      { $set: { dependencies: ['tn_ghost'] } },
    );
    const gate = await startableTasks(db, WS, [await fresh(a.nodeId)]);
    expect(gate.waiting).toEqual([]);
    expect(gate.startable.map((n: Any) => n.nodeId)).toEqual([a.nodeId]);
  });

  it('multiple blockers: released only when every one of them is released', async () => {
    const a = await add('A');
    const b = await add('B');
    const c = await add('C');
    await dep(a.nodeId, b.nodeId);
    await dep(a.nodeId, c.nodeId);
    await call('set-state', { nodeId: b.nodeId, state: 'done' });
    const half = await startableTasks(db, WS, [await fresh(a.nodeId), await fresh(b.nodeId), await fresh(c.nodeId)]);
    expect(half.waiting.map((w: Any) => w.node.nodeId)).toEqual([a.nodeId]);
    expect(half.waiting[0].reason).toContain('"C" (pending)');

    await call('set-state', { nodeId: c.nodeId, state: 'done' });
    const all = await startableTasks(db, WS, [await fresh(a.nodeId), await fresh(b.nodeId), await fresh(c.nodeId)]);
    expect(all.waiting).toEqual([]);
  });

  it('candidates without dependencies pass through untouched (zero overhead shape)', async () => {
    const plain = await add('Plain');
    const gate = await startableTasks(db, WS, [await fresh(plain.nodeId)]);
    expect(gate.startable.map((n: Any) => n.nodeId)).toEqual([plain.nodeId]);
    expect(gate.waiting).toEqual([]);
  });
});

// =============================================================================
// Events (todo.dependency_added / todo.dependency_removed)
// =============================================================================

describe('todo — dependencies: events', () => {
  it('add-dependency emits todo.dependency_added with the blocker payload', async () => {
    captureBus();
    const a = await add('A');
    const b = await add('B');
    await settle();
    busEvents = [];

    await dep(a.nodeId, b.nodeId);
    await settle();

    const added = busEvents.find((e) => e.topic === 'todo.dependency_added');
    expect(added).toBeDefined();
    expect(added!.payload).toMatchObject({ workspaceId: WS, nodeId: a.nodeId });
    expect(added!.payload).toMatchObject({ blockerNodeId: b.nodeId, blockerText: 'B', blockerState: 'pending' });
    expect(added!.payload.occurredAt).toBeDefined();
  });

  it('remove-dependency emits todo.dependency_removed', async () => {
    captureBus();
    const a = await add('A');
    const b = await add('B');
    await dep(a.nodeId, b.nodeId);
    await settle();
    busEvents = [];

    await call('remove-dependency', { nodeId: a.nodeId, blockerNodeId: b.nodeId });
    await settle();

    const removed = busEvents.find((e) => e.topic === 'todo.dependency_removed');
    expect(removed).toBeDefined();
    expect(removed!.payload).toMatchObject({ nodeId: a.nodeId, blockerNodeId: b.nodeId, blockerText: 'B' });
  });

  it('an idempotent add (already present) emits nothing', async () => {
    captureBus();
    const a = await add('A');
    const b = await add('B');
    await dep(a.nodeId, b.nodeId);
    await settle();
    busEvents = [];

    await dep(a.nodeId, b.nodeId); // no-op
    await settle();
    expect(busEvents.find((e) => e.topic === 'todo.dependency_added')).toBeUndefined();
  });

  it('a subscribed channel receives the dependency events (delivery + wakeUpAgent)', async () => {
    await call('subscribe-to-todo', { callerUserId: USER, callerChannelId: CH });
    await settle();
    injected = [];

    const a = await add('A');
    const b = await add('B');
    await settle();
    injected = [];

    await dep(a.nodeId, b.nodeId);
    await settle();

    expect(injected).toHaveLength(1);
    expect(injected[0].channelId).toBe(CH);
    expect(injected[0].event.metadata.todoEventType).toBe('dependency_added');
    expect(injected[0].event.metadata.blockerNodeId).toBe(b.nodeId);
    expect(injected[0].event.wakeUpAgent).toBe(true);
  });
});
