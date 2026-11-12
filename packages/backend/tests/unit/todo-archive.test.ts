/**
 * Unit tests — todo archive (set-archived / archive-finished / completedAt /
 * archived filtering in reads):
 *   - set-archived: sets archived + archivedAt, logs "archived"/"unarchived",
 *     is idempotent, rejects a node with non-archived children
 *     (HAS_ACTIVE_CHILDREN), works on groups, unarchiving does not cascade;
 *   - archive-finished: archives done (and cancelled unless
 *     includeCancelled: false), skips open tasks and groups, is idempotent,
 *     skips nodes with active children, honours olderThanDays via completedAt
 *     (a task finished 6 days ago is archived with olderThanDays=5, not with
 *     olderThanDays=7);
 *   - completedAt: set by the done/cancelled transitions, cleared when the
 *     task leaves them, derived for legacy nodes from the log (else
 *     updatedAt);
 *   - reads: get-tree / get-day / search-nodes hide archived nodes by default
 *     (a node under an archived ancestor is hidden too) and return them with
 *     includeArchived: true; tree rows carry archived / archivedAt /
 *     completedAt.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Db, MongoClient } from 'mongodb';
import { config } from '../../src/config';
// The capability registry first: todo.ts imports McaActionError from it, so
// loading todo.ts on its own would hit the registry's circular import.
import { setMcaActionDeps, getMcaActionDeps } from '../../src/mca-actions';
import { todoCapability } from '../../src/mca-actions/todo';
import { TodoSubscriptionService } from '../../src/services/todo-subscription-service';
import { setTodoBusDispatch, type TodoBusDispatchFn } from '../../src/services/todo-event-emitters';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = `teros_todo_archive_test_${Date.now()}`;
const OBJ_PATH = join(tmpdir(), `todo-archive-objects-${Date.now()}`);

const MCA_ID = 'mca.teros.todo-list';
const WS = 'ws_arch_1';
const APP = 'app_arch_1';
const USER = 'user_arch_owner';

let client: MongoClient;
let db: Db;
const agentApps = config.agentApps as { objectStoragePath: string };
let previousObjectPath: string;
let svc: TodoSubscriptionService;
let previousDeps: Record<string, unknown> = {};
let previousBus: TodoBusDispatchFn | null = null;

const ctx = { mcaId: MCA_ID, appId: APP };

type Any = any;

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

async function add(text: string, extra: Record<string, unknown> = {}): Promise<Any> {
  const { state, kind, ...rest } = extra as { state?: string; kind?: string };
  const body = kind === 'group' ? { text, kind, ...rest } : { text, state: state ?? 'pending', ...rest };
  return (await call('add-node', body)).node;
}

async function raw(nodeId: string): Promise<Any> {
  return db.collection('todo_nodes').findOne({ nodeId }, { projection: { _id: 0 } });
}

async function lastLog(nodeId: string): Promise<string | undefined> {
  const n = await raw(nodeId);
  return n.log.at(-1)?.text;
}

/** Flush the fire-and-forget event delivery (todo-events test pattern). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
  await db.collection('apps').insertOne({ appId: APP, mcaId: MCA_ID, ownerId: WS });
  await db.collection('workspaces').insertOne({ workspaceId: WS, ownerId: USER, name: 'WS', status: 'active' });

  svc = new TodoSubscriptionService(db);
  await settle();
  previousDeps = { ...getMcaActionDeps() } as Record<string, unknown>;
  setMcaActionDeps({ todoSubscriptions: svc } as any);
  previousBus = null;
});

afterEach(async () => {
  setMcaActionDeps(previousDeps as any);
  setTodoBusDispatch(previousBus);
});

// =============================================================================
// set-archived
// =============================================================================

describe('todo — archive: set-archived', () => {
  it('archives a task: archived + archivedAt, log entry, idempotent', async () => {
    const t = await add('Finished task', { state: 'pending' });
    await call('set-state', { nodeId: t.nodeId, state: 'done' });

    const res = await call('set-archived', { nodeId: t.nodeId, archived: true });
    expect(res.node.archived).toBe(true);
    expect(typeof res.node.archivedAt).toBe('number');

    const stored = await raw(t.nodeId);
    expect(stored.archived).toBe(true);
    expect(stored.archivedAt).toBe(res.node.archivedAt);
    expect(await lastLog(t.nodeId)).toBe('archived');

    // Idempotent: archiving again changes nothing (and logs nothing).
    const again = await call('set-archived', { nodeId: t.nodeId, archived: true });
    expect(again.node.archived).toBe(true);
    expect((await raw(t.nodeId)).log.filter((e: Any) => e.text === 'archived').length).toBe(1);
  });

  it('unarchives: archived false, archivedAt null, log "unarchived", descendants untouched', async () => {
    const parent = await add('Parent');
    const child = await add('Child', { parentId: parent.nodeId });
    await call('set-archived', { nodeId: child.nodeId, archived: true });
    await call('set-archived', { nodeId: parent.nodeId, archived: true });

    const res = await call('set-archived', { nodeId: child.nodeId, archived: false });
    expect(res.node.archived).toBe(false);
    expect(res.node.archivedAt).toBeNull();
    expect(await lastLog(child.nodeId)).toBe('unarchived');
    // The parent stays archived and the child is still hidden by the cascade.
    expect((await raw(parent.nodeId)).archived).toBe(true);
    const tree = await call('get-tree');
    expect(tree.tree.find((n: Any) => n.nodeId === child.nodeId)).toBeUndefined();
  });

  it('rejects archiving a node with non-archived children (HAS_ACTIVE_CHILDREN)', async () => {
    const parent = await add('Parent');
    await add('Active child', { parentId: parent.nodeId });
    const err = await failure('set-archived', { nodeId: parent.nodeId, archived: true });
    expect(err.code).toBe('HAS_ACTIVE_CHILDREN');
    expect((await raw(parent.nodeId)).archived).toBeUndefined();
  });

  it('works on groups and on nodes without children', async () => {
    const g = await add('Group', { kind: 'group' });
    const res = await call('set-archived', { nodeId: g.nodeId, archived: true });
    expect(res.node.archived).toBe(true);
    expect((await raw(g.nodeId)).archived).toBe(true);
  });

  it('fails NOT_FOUND for an unknown node and INVALID_INPUT without archived', async () => {
    const err = await failure('set-archived', { nodeId: 'tn_missing', archived: true });
    expect(err.code).toBe('NOT_FOUND');
    const bad = await failure('set-archived', { nodeId: 'tn_x' });
    expect(bad.code).toBe('INVALID_INPUT');
  });
});

// =============================================================================
// completedAt
// =============================================================================

describe('todo — archive: completedAt', () => {
  it('is set on the done transition, cleared when the task reopens', async () => {
    const t = await add('Task');
    expect((await raw(t.nodeId)).completedAt ?? null).toBeNull();

    await call('set-state', { nodeId: t.nodeId, state: 'done' });
    const done = await raw(t.nodeId);
    expect(typeof done.completedAt).toBe('number');

    await call('set-state', { nodeId: t.nodeId, state: 'working' });
    const reopened = await raw(t.nodeId);
    expect(reopened.completedAt ?? null).toBeNull();
  });

  it('is set on cancel and derived for a legacy node (no stored completedAt) from the log', async () => {
    const t = await add('Task');
    await call('set-state', { nodeId: t.nodeId, state: 'cancelled' });
    expect(typeof (await raw(t.nodeId)).completedAt).toBe('number');

    // Legacy: strip completedAt, keep the "… → done" log line.
    const legacy = await add('Legacy');
    await call('set-state', { nodeId: legacy.nodeId, state: 'done' });
    await db.collection('todo_nodes').updateOne({ nodeId: legacy.nodeId }, { $unset: { completedAt: '' } });
    const tree = await call('get-tree', { includeArchived: true });
    const row = tree.tree.find((n: Any) => n.nodeId === legacy.nodeId);
    expect(typeof row.completedAt).toBe('number');
  });
});

// =============================================================================
// archive-finished
// =============================================================================

describe('todo — archive: archive-finished', () => {
  it('archives done tasks (and cancelled by default), skipping open tasks and groups', async () => {
    const done = await add('Done');
    await call('set-state', { nodeId: done.nodeId, state: 'done' });
    const cancelled = await add('Cancelled');
    await call('set-state', { nodeId: cancelled.nodeId, state: 'cancelled' });
    const open = await add('Open');
    const group = await add('Group', { kind: 'group' });

    const res = await call('archive-finished', {});
    expect(res.archived).toBe(2);
    expect(res.skipped).toBe(0);
    expect((await raw(done.nodeId)).archived).toBe(true);
    expect((await raw(cancelled.nodeId)).archived).toBe(true);
    expect((await raw(open.nodeId)).archived).toBeUndefined();
    expect((await raw(group.nodeId)).archived).toBeUndefined();
  });

  it('includeCancelled: false leaves cancelled tasks alone', async () => {
    const done = await add('Done');
    await call('set-state', { nodeId: done.nodeId, state: 'done' });
    const cancelled = await add('Cancelled');
    await call('set-state', { nodeId: cancelled.nodeId, state: 'cancelled' });

    const res = await call('archive-finished', { includeCancelled: false });
    expect(res.archived).toBe(1);
    expect((await raw(done.nodeId)).archived).toBe(true);
    expect((await raw(cancelled.nodeId)).archived).toBeUndefined();
  });

  it('is idempotent: already-archived tasks are not counted again', async () => {
    const done = await add('Done');
    await call('set-state', { nodeId: done.nodeId, state: 'done' });
    expect((await call('archive-finished', {})).archived).toBe(1);
    const second = await call('archive-finished', {});
    expect(second.archived).toBe(0);
    expect(second.skipped).toBe(0);
  });

  it('skips finished tasks with non-archived children instead of failing', async () => {
    const parent = await add('Parent');
    const child = await add('Child', { parentId: parent.nodeId });
    await call('set-state', { nodeId: parent.nodeId, state: 'done' });
    await call('set-state', { nodeId: child.nodeId, state: 'done' });

    const res = await call('archive-finished', {});
    expect(res.archived).toBe(1); // the child only
    expect((await raw(child.nodeId)).archived).toBe(true);
    expect((await raw(parent.nodeId)).archived).toBeUndefined();

    // A second sweep archives the parent (its child is archived now).
    expect((await call('archive-finished', {})).archived).toBe(1);
    expect((await raw(parent.nodeId)).archived).toBe(true);
  });

  it('honours olderThanDays via completedAt (6 days old: archived at 5, not at 7)', async () => {
    const sixDays = await add('Six days');
    await call('set-state', { nodeId: sixDays.nodeId, state: 'done' });
    const sixDaysAgo = Date.now() - 6 * 24 * 60 * 60 * 1000;
    await db.collection('todo_nodes').updateOne({ nodeId: sixDays.nodeId }, { $set: { completedAt: sixDaysAgo } });

    const fresh = await add('Fresh');
    await call('set-state', { nodeId: fresh.nodeId, state: 'done' });

    // 6-day-old task is OLDER than 5 days → archived; the fresh one is not.
    const at5 = await call('archive-finished', { olderThanDays: 5 });
    expect(at5.archived).toBe(1);
    expect((await raw(sixDays.nodeId)).archived).toBe(true);
    expect((await raw(fresh.nodeId)).archived).toBeUndefined();
  });

  it('olderThanDays=7 does NOT archive a task finished 6 days ago', async () => {
    const sixDays = await add('Six days');
    await call('set-state', { nodeId: sixDays.nodeId, state: 'done' });
    await db
      .collection('todo_nodes')
      .updateOne({ nodeId: sixDays.nodeId }, { $set: { completedAt: Date.now() - 6 * 24 * 60 * 60 * 1000 } });

    const res = await call('archive-finished', { olderThanDays: 7 });
    expect(res.archived).toBe(0);
    expect(res.skipped).toBe(1);
    expect((await raw(sixDays.nodeId)).archived).toBeUndefined();
  });
});

// =============================================================================
// Reads hide archived by default
// =============================================================================

describe('todo — archive: read filtering', () => {
  it('get-tree hides archived nodes and their subtree; includeArchived returns them with the archive fields', async () => {
    const root = await add('Root');
    const child = await add('Child', { parentId: root.nodeId });
    const grand = await add('Grand', { parentId: child.nodeId });
    // Archive bottom-up: the grandchild, then the child (its only child is
    // archived now), so the child's subtree is hidden by the cascade.
    await call('set-state', { nodeId: grand.nodeId, state: 'done' });
    await call('set-archived', { nodeId: grand.nodeId, archived: true });
    await call('set-archived', { nodeId: child.nodeId, archived: true });

    const def = await call('get-tree');
    const rootNode = def.tree.find((n: Any) => n.nodeId === root.nodeId);
    // The child is hidden; with no visible children left, `children` is omitted.
    expect(rootNode.children?.some((n: Any) => n.nodeId === child.nodeId) ?? false).toBe(false);

    const inc = await call('get-tree', { includeArchived: true });
    const incChild = inc.tree.find((n: Any) => n.nodeId === root.nodeId).children.find((n: Any) => n.nodeId === child.nodeId);
    expect(incChild.archived).toBe(true);
    expect(typeof incChild.archivedAt).toBe('number');
    expect(incChild.children.some((n: Any) => n.nodeId === grand.nodeId)).toBe(true);

    // A node added under an archived parent is never archived itself, but the
    // cascade hides it in the default tree; includeArchived surfaces it.
    const stray = await add('Stray', { parentId: child.nodeId });
    const defStray = await call('get-tree');
    expect(defStray.tree.some((n: Any) => n.nodeId === stray.nodeId)).toBe(false);
    const incStray = await call('get-tree', { includeArchived: true });
    const incChild2 = incStray.tree.find((n: Any) => n.nodeId === root.nodeId).children.find((n: Any) => n.nodeId === child.nodeId);
    expect(incChild2.children.find((n: Any) => n.nodeId === stray.nodeId).archived).toBe(false);

    // Active nodes read archived: false.
    expect(rootNode.archived).toBe(false);
    expect(rootNode.completedAt).toBeNull();
  });

  it('get-day hides archived tasks from every list', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const t = await add('Planned');
    await call('plan-node', { nodeId: t.nodeId, day: today });
    await call('set-state', { nodeId: t.nodeId, state: 'done' });
    await call('set-archived', { nodeId: t.nodeId, archived: true });

    const day = await call('get-day', { day: today });
    expect(day.tasks.find((n: Any) => n.nodeId === t.nodeId)).toBeUndefined();

    const dayInc = await call('get-day', { day: today }); // no includeArchived arg — always hidden
    expect(dayInc.tasks.find((n: Any) => n.nodeId === t.nodeId)).toBeUndefined();
  });

  it('search-nodes hides archived matches by default and returns them with includeArchived', async () => {
    const t = await add('Zebra searchable');
    await call('set-archived', { nodeId: t.nodeId, archived: true });

    const def = await call('search-nodes', { query: 'Zebra' });
    expect(def.results).toEqual([]);

    const inc = await call('search-nodes', { query: 'Zebra', includeArchived: true });
    expect(inc.results.length).toBe(1);
    expect(inc.results[0].nodeId).toBe(t.nodeId);
  });

  it('set-archived emits todo.task_updated with fields [archived]', async () => {
    // A subscriber so the dispatch has somewhere to go (the service skips
    // dispatch with no subscription rows in the workspace).
    const CH = 'ch_arch_events';
    await db.collection('todo_subscriptions').insertOne({ workspaceId: WS, channelId: CH, filter: {} });
    const injected: Any[] = [];
    svc.setEventInjector(async (event: Any) => {
      injected.push(event);
      return { success: true };
    });
    const t = await add('Event task');
    await call('set-archived', { nodeId: t.nodeId, archived: true });
    await settle();
    const upd = injected.find((e) => e.metadata?.todoEventType === 'task_updated');
    expect(upd).toBeTruthy();
    expect(upd.metadata.fields).toEqual(['archived']);
  });
});
