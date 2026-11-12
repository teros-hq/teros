/**
 * Unit tests — mca-actions/todo (mca.teros.todo-list backend actions).
 *
 * Covers every action against a real MongoDB (MONGODB_URI, throwaway db):
 *   - tenancy: token app must be a todo-list app; workspace from the channel
 *     or app.ownerId; other workspaces' nodes answer NOT_FOUND.
 *   - the former 11 actions (add/get/tree/update/toggle-complete/collapse/
 *     move/delete/search/log) with their positions, cascade and errors.
 *   - states (docs/specs/tasks/20261024_todo-improvements-plan.md, task-states
 *     §7): the full human transition matrix, blocked reason, done ⇒ 100%.
 *   - groups (§7bis): no state/progress/output, never inside a task.
 *   - effective progress (reported, else derived recursively from children).
 *   - input/output (markdown, form, file → object storage) and the log
 *     entries every state/progress/kind/IO change appends.
 *   - toggle-instruction-item.
 */

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Db, MongoClient } from 'mongodb';
import { config } from '../../src/config';
// The capability registry first: todo.ts imports McaActionError from it, so
// loading todo.ts on its own would hit the registry's circular import.
import { handleMcaAction, type McaActionCtx } from '../../src/mca-actions';
import {
  MAX_IO_FILE_BYTES,
  NODE_STATES,
  STATE_TRANSITIONS,
  todoCapability,
} from '../../src/mca-actions/todo';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = `teros_todo_actions_test_${Date.now()}`;
const OBJ_PATH = join(tmpdir(), `todo-actions-objects-${Date.now()}`);

const MCA_ID = 'mca.teros.todo-list';
const WS = 'ws_todo_1';
const OTHER_WS = 'ws_todo_2';
const APP = 'app_todo_1';
const OTHER_APP = 'app_todo_2';

let client: MongoClient;
let db: Db;
const agentApps = config.agentApps as { objectStoragePath: string };
let previousObjectPath: string;

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

async function add(text: string, extra: Record<string, unknown> = {}): Promise<Any> {
  // Tests exercise the state machine from pending — the creation default is
  // planning now, so pin pending unless the test asks for another state.
  // Groups have no state, so only tasks get the pin.
  const { state, kind, ...rest } = extra as { state?: string; kind?: string };
  const body =
    kind === 'group'
      ? { text, kind, ...rest }
      : { text, state: state ?? 'pending', ...rest };
  return (await call('add-node', body)).node;
}

async function raw(nodeId: string): Promise<Any> {
  return db.collection('todo_nodes').findOne({ nodeId }, { projection: { _id: 0 } });
}

async function lastLog(nodeId: string): Promise<string | undefined> {
  const n = await raw(nodeId);
  return n.log.at(-1)?.text;
}

/** Insert a node straight into Mongo (states the actions would need several steps to reach). */
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
    ...doc,
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
  for (const col of ['todo_nodes', 'apps', 'channels', 'agent_app_objects', 'workspaces', 'workspace_members', 'agents', 'users']) {
    await db.collection(col).deleteMany({});
  }
  await db.collection('apps').insertMany([
    { appId: APP, mcaId: MCA_ID, ownerId: WS },
    { appId: OTHER_APP, mcaId: MCA_ID, ownerId: OTHER_WS },
    { appId: 'app_other_mca', mcaId: 'mca.teros.bash', ownerId: WS },
  ]);
});

// =============================================================================
// Tenancy
// =============================================================================

describe('todo — tenancy', () => {
  it('is dispatched as todo/<action> with the domain code and status', async () => {
    const res = await handleMcaAction(ctx, db, 'todo/get-node', { nodeId: 'tn_missing' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND', error: 'Node "tn_missing" not found.' });
  });

  it('ping answers without resolving a workspace', async () => {
    expect(await call('ping', {}, { mcaId: MCA_ID })).toEqual({ ok: true });
  });

  it('rejects a token without appId or for another MCA app (403)', async () => {
    const noApp = await failure('get-tree', {}, { mcaId: MCA_ID });
    expect(noApp.code).toBe('FORBIDDEN');
    expect(noApp.status).toBe(403);
    const otherMca = await failure('get-tree', {}, { mcaId: MCA_ID, appId: 'app_other_mca' });
    expect(otherMca.code).toBe('FORBIDDEN');
  });

  it('keys by app.ownerId, ignoring any workspaceId in the body', async () => {
    const node = await add('Mine', { workspaceId: OTHER_WS });
    expect((await raw(node.nodeId)).workspaceId).toBe(WS);
  });

  it('prefers the channel workspace when the callback carries a channel', async () => {
    await db.collection('channels').insertOne({ channelId: 'ch_1', workspaceId: OTHER_WS });
    const node = await add('Via channel', {});
    const viaChannel = (await call('add-node', { text: 'x' }, { ...ctx, channelId: 'ch_1' })).node;
    expect((await raw(node.nodeId)).workspaceId).toBe(WS);
    expect((await raw(viaChannel.nodeId)).workspaceId).toBe(OTHER_WS);
  });

  it('hides nodes of another workspace (NOT_FOUND)', async () => {
    const node = await add('Private');
    for (const [action, body] of [
      ['get-node', { nodeId: node.nodeId }],
      ['update-node', { nodeId: node.nodeId, text: 'x' }],
      ['toggle-complete', { nodeId: node.nodeId }],
      ['set-state', { nodeId: node.nodeId, state: 'working' }],
      ['set-progress', { nodeId: node.nodeId, progress: 10 }],
      ['set-output', { nodeId: node.nodeId, output: null }],
      ['delete-node', { nodeId: node.nodeId }],
    ] as const) {
      const err = await failure(action, body, otherCtx);
      expect(err.code).toBe('NOT_FOUND');
      expect(err.status).toBe(404);
    }
    expect(await raw(node.nodeId)).not.toBeNull();
  });
});

// =============================================================================
// Former actions
// =============================================================================

describe('todo — add-node', () => {
  it('creates a pending task at the end of its siblings', async () => {
    const root = await add('Root');
    const a = await call('add-node', { text: 'A', parentId: root.nodeId });
    const b = await add('B', { parentId: root.nodeId, description: 'd', instructions: 'i' });
    expect(root.nodeId).toMatch(/^tn_[0-9A-Za-z]{16}$/);
    expect(a.parentText).toBe('Root');
    expect(a.node.position).toBe(0);
    expect(b.position).toBe(1);
    expect(b).toMatchObject({
      text: 'B',
      description: 'd',
      instructions: 'i',
      kind: 'task',
      state: 'pending',
      blockedReason: null,
      reportedProgress: null,
      completed: false,
      collapsed: false,
    });
    expect(await raw(b.nodeId)).toMatchObject({ kind: 'task', state: 'pending', progress: null, input: null, output: null });
    // The creation default is planning when no state is passed (agents and
    // UI both birth ideas; pending means ready-to-start).
    const idea = await call('add-node', { text: 'Idea', parentId: root.nodeId });
    expect(idea.node.state).toBe('planning');
  });

  it('accepts an initial state; done means completed and 100%', async () => {
    const n = await add('Done already', { state: 'done' });
    expect(n).toMatchObject({ state: 'done', completed: true, reportedProgress: 100 });
    const p = await add('Idea', { state: 'planning' });
    expect(p.state).toBe('planning');
  });

  it('creates groups without state, progress or output', async () => {
    const g = await add('Home', { kind: 'group' });
    expect(g).toMatchObject({ kind: 'group', state: null, reportedProgress: null, completed: false });
    const stored = await raw(g.nodeId);
    expect(stored.state).toBeUndefined();
    expect(stored.progress).toBeUndefined();
    expect(stored.output).toBeUndefined();
  });

  it('rejects a group with a state, a blocked task, and a group inside a task', async () => {
    expect((await failure('add-node', { text: 'g', kind: 'group', state: 'pending' })).code).toBe('INVALID_INPUT');
    expect((await failure('add-node', { text: 't', state: 'blocked' })).code).toBe('REASON_REQUIRED');
    const task = await add('Task');
    expect((await failure('add-node', { text: 'g', kind: 'group', parentId: task.nodeId })).code).toBe('GROUP_IN_TASK');
    const group = await add('Group', { kind: 'group' });
    expect((await add('Sub', { kind: 'group', parentId: group.nodeId })).kind).toBe('group');
    expect((await add('T', { parentId: group.nodeId })).kind).toBe('task');
  });

  it('validates input and the parent', async () => {
    expect((await failure('add-node', {})).code).toBe('INVALID_INPUT');
    expect((await failure('add-node', { text: 'x', kind: 'folder' })).code).toBe('INVALID_INPUT');
    const missing = await failure('add-node', { text: 'x', parentId: 'tn_missing' });
    expect(missing.code).toBe('NOT_FOUND');
    expect(missing.message).toBe('Parent node not found: tn_missing');
    expect(await db.collection('todo_nodes').countDocuments()).toBe(0);
  });
});

describe('todo — get-node', () => {
  it('returns the full detail with kind, state, transitions and progress', async () => {
    const n = await add('Task', { instructions: 'do it' });
    await call('add-log-entry', { nodeId: n.nodeId, text: 'note' });
    const { node } = await call('get-node', { nodeId: n.nodeId });
    expect(node).toMatchObject({
      nodeId: n.nodeId,
      parentId: null,
      text: 'Task',
      instructions: 'do it',
      kind: 'task',
      state: 'pending',
      blockedReason: null,
      allowedTransitions: ['working', 'done', 'planning', 'cancelled'],
      progress: null,
      reportedProgress: null,
      input: null,
      output: null,
      hasInput: false,
      hasOutput: false,
      completed: false,
    });
    expect(node.log.map((l: Any) => l.text)).toEqual(['note']);
  });

  it('derives progress from the whole subtree', async () => {
    const parent = await add('Parent');
    const a = await add('A', { parentId: parent.nodeId });
    const b = await add('B', { parentId: parent.nodeId });
    await add('B1', { parentId: b.nodeId, state: 'done' });
    await add('B2', { parentId: b.nodeId });
    await call('toggle-complete', { nodeId: a.nodeId });
    // A = 100, B = mean(100, 0) = 50 → parent = 75
    expect((await call('get-node', { nodeId: parent.nodeId })).node.progress).toBe(75);
    expect((await call('get-node', { nodeId: b.nodeId })).node.progress).toBe(50);
  });

  it('fails NOT_FOUND / INVALID_INPUT', async () => {
    expect((await failure('get-node', { nodeId: 'tn_nope' })).message).toBe('Node "tn_nope" not found.');
    expect((await failure('get-node', {})).code).toBe('INVALID_INPUT');
  });
});

describe('todo — get-tree', () => {
  it('nests by position with counts and the new fields', async () => {
    const g = await add('Home', { kind: 'group' });
    const t1 = await add('Clean', { parentId: g.nodeId });
    const t2 = await add('Cook', { parentId: g.nodeId });
    await add('Shop', { parentId: t2.nodeId });
    await call('toggle-complete', { nodeId: t1.nodeId });
    await call('set-output', { nodeId: t1.nodeId, output: { format: 'markdown', markdown: 'clean!' } });
    await call('move-node', { nodeId: t2.nodeId, newPosition: 0 });

    const { tree } = await call('get-tree', {});
    expect(tree).toHaveLength(1);
    const [home] = tree;
    expect(home).toMatchObject({
      kind: 'group',
      state: null,
      childCount: 2,
      completedChildren: 1,
      progress: 50, // Clean 100, Cook 0 (its only child is open)
      reportedProgress: null,
      hasInput: false,
      hasOutput: false,
    });
    expect(home.children.map((c: Any) => c.text)).toEqual(['Cook', 'Clean']);
    const clean = home.children[1];
    expect(clean).toMatchObject({ state: 'done', completed: true, progress: 100, hasOutput: true });
    expect(clean.output).toBeUndefined();
    expect(clean.instructions).toBeUndefined();
    expect(clean.log).toBeUndefined();
  });

  it('supports depth and a subtree root', async () => {
    const r = await add('R');
    const c = await add('C', { parentId: r.nodeId });
    await add('GC', { parentId: c.nodeId });
    const shallow = (await call('get-tree', { depth: 0 })).tree;
    expect(shallow[0].children).toBeUndefined();
    expect(shallow[0].childCount).toBe(1);
    const sub = (await call('get-tree', { nodeId: c.nodeId })).tree;
    expect(sub).toHaveLength(1);
    expect(sub[0].children.map((n: Any) => n.text)).toEqual(['GC']);
    expect((await call('get-tree', { nodeId: 'tn_missing' })).tree).toEqual([]);
    expect((await failure('get-tree', { depth: 101 })).code).toBe('INVALID_INPUT');
  });

  it('reads legacy nodes (no state, no kind) from completed', async () => {
    await seed({ nodeId: 'legacy_done', completed: true });
    await seed({ nodeId: 'legacy_open', completed: false, position: 1 });
    const { tree } = await call('get-tree', {});
    expect(tree.map((n: Any) => [n.kind, n.state, n.progress])).toEqual([
      ['task', 'done', 100],
      ['task', 'pending', null],
    ]);
  });

  it('a reported progress wins over the derived one', async () => {
    const p = await add('P');
    await add('C', { parentId: p.nodeId, state: 'done' });
    await call('set-progress', { nodeId: p.nodeId, progress: 20 });
    expect((await call('get-tree', {})).tree[0]).toMatchObject({ progress: 20, reportedProgress: 20 });
  });
});

describe('todo — update-node', () => {
  it('updates only the given fields', async () => {
    const n = await add('Old', { description: 'keep' });
    const { node } = await call('update-node', { nodeId: n.nodeId, text: 'New', instructions: '- [ ] a' });
    expect(node).toMatchObject({ text: 'New', description: 'keep', instructions: '- [ ] a' });
  });

  it('requires at least one field', async () => {
    const n = await add('X');
    expect((await failure('update-node', { nodeId: n.nodeId })).code).toBe('INVALID_INPUT');
  });
});

describe('todo — toggle-complete', () => {
  it('marks done with descendants (state, completed, 100%) and logs', async () => {
    const p = await add('P');
    const c = await add('C', { parentId: p.nodeId });
    await call('set-state', { nodeId: c.nodeId, state: 'working' });
    await call('set-state', { nodeId: c.nodeId, state: 'blocked', reason: 'waiting' });
    const { node } = await call('toggle-complete', { nodeId: p.nodeId });
    expect(node).toMatchObject({ completed: true, state: 'done', reportedProgress: 100 });
    expect(await raw(c.nodeId)).toMatchObject({ state: 'done', completed: true, progress: 100, blockedReason: null });
    expect(await lastLog(p.nodeId)).toBe('Marked as completed (and 1 descendant)');
  });

  it('reopens to pending with the done descendants and clears their 100%', async () => {
    const p = await add('P');
    const c = await add('C', { parentId: p.nodeId });
    await call('toggle-complete', { nodeId: p.nodeId });
    const { node } = await call('toggle-complete', { nodeId: p.nodeId });
    expect(node).toMatchObject({ completed: false, state: 'pending', reportedProgress: null });
    expect(await raw(c.nodeId)).toMatchObject({ state: 'pending', completed: false, progress: null });
    expect(await lastLog(p.nodeId)).toBe('Marked as not completed (and 1 descendant)');
  });

  it('un-completing keeps a progress that is not the automatic 100', async () => {
    const n = await add('N');
    await call('toggle-complete', { nodeId: n.nodeId });
    await call('set-progress', { nodeId: n.nodeId, progress: 80 });
    const { node } = await call('toggle-complete', { nodeId: n.nodeId });
    expect(node).toMatchObject({ state: 'pending', reportedProgress: 80 });
  });

  it('handles legacy nodes and rejects groups', async () => {
    await seed({ nodeId: 'legacy', completed: true });
    expect((await call('toggle-complete', { nodeId: 'legacy' })).node.state).toBe('pending');
    const g = await add('G', { kind: 'group' });
    expect((await failure('toggle-complete', { nodeId: g.nodeId })).code).toBe('NOT_A_TASK');
  });
});

describe('todo — toggle-collapse', () => {
  it('flips collapsed', async () => {
    const n = await add('N');
    expect((await call('toggle-collapse', { nodeId: n.nodeId })).node.collapsed).toBe(true);
    expect((await call('toggle-collapse', { nodeId: n.nodeId })).node.collapsed).toBe(false);
    expect((await failure('toggle-collapse', { nodeId: 'tn_x' })).code).toBe('NOT_FOUND');
  });
});

describe('todo — move-node', () => {
  async function childrenOf(parentId: string | null): Promise<string[]> {
    const docs = await db.collection('todo_nodes').find({ parentId }).sort({ position: 1 }).toArray();
    return docs.map((d) => d.text);
  }

  it('reorders among siblings when newParentId is omitted', async () => {
    const a = await add('A');
    await add('B');
    await add('C');
    await call('move-node', { nodeId: a.nodeId, newPosition: 2 });
    expect(await childrenOf(null)).toEqual(['B', 'C', 'A']);
  });

  it('moves across parents, reindexing the old siblings, and back to root with null', async () => {
    const p = await add('P');
    const a = await add('A');
    await add('B');
    await add('X', { parentId: p.nodeId });
    const moved = (await call('move-node', { nodeId: a.nodeId, newParentId: p.nodeId, newPosition: 0 })).node;
    expect(moved).toMatchObject({ parentId: p.nodeId, position: 0 });
    expect(await childrenOf(p.nodeId)).toEqual(['A', 'X']);
    expect((await raw((await db.collection('todo_nodes').findOne({ text: 'B' }))!.nodeId)).position).toBe(1);
    await call('move-node', { nodeId: a.nodeId, newParentId: null, newPosition: 99 });
    expect(await childrenOf(null)).toEqual(['P', 'B', 'A']);
  });

  it('rejects circular moves and unknown parents', async () => {
    const p = await add('P');
    const c = await add('C', { parentId: p.nodeId });
    expect((await failure('move-node', { nodeId: p.nodeId, newParentId: p.nodeId })).code).toBe('CIRCULAR_MOVE');
    expect((await failure('move-node', { nodeId: p.nodeId, newParentId: c.nodeId })).code).toBe('CIRCULAR_MOVE');
    expect((await failure('move-node', { nodeId: p.nodeId, newParentId: 'tn_x' })).code).toBe('NOT_FOUND');
  });

  it('never puts a group inside a task', async () => {
    const task = await add('Task');
    const group = await add('Group', { kind: 'group' });
    const other = await add('Other', { kind: 'group' });
    expect((await failure('move-node', { nodeId: group.nodeId, newParentId: task.nodeId })).code).toBe('GROUP_IN_TASK');
    expect((await call('move-node', { nodeId: group.nodeId, newParentId: other.nodeId })).node.parentId).toBe(other.nodeId);
    expect((await call('move-node', { nodeId: task.nodeId, newParentId: group.nodeId })).node.parentId).toBe(group.nodeId);
  });
});

describe('todo — delete-node', () => {
  it('deletes the subtree and reindexes siblings', async () => {
    const a = await add('A');
    await add('A1', { parentId: a.nodeId });
    const b = await add('B');
    const res = await call('delete-node', { nodeId: a.nodeId });
    expect(res).toMatchObject({ deleted: true, nodeId: a.nodeId, node: { text: 'A' } });
    expect(await db.collection('todo_nodes').countDocuments()).toBe(1);
    expect((await raw(b.nodeId)).position).toBe(0);
    expect((await failure('delete-node', { nodeId: a.nodeId })).code).toBe('NOT_FOUND');
  });
});

describe('todo — search-nodes', () => {
  it('matches case-insensitively and literally, with breadcrumbs', async () => {
    const p = await add('Project (alpha)');
    await add('Buy MILK', { parentId: p.nodeId });
    await add('Unrelated');
    const res = (await call('search-nodes', { query: 'milk' })).results;
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ text: 'Buy MILK', path: 'Project (alpha) / Buy MILK', kind: 'task', state: 'pending' });
    expect((await call('search-nodes', { query: '(alpha)' })).results).toHaveLength(1);
    expect((await call('search-nodes', { query: '.*' })).results).toHaveLength(0);
  });
});

describe('todo — add-log-entry', () => {
  it('appends entries in order', async () => {
    const n = await add('N');
    await call('add-log-entry', { nodeId: n.nodeId, text: 'one' });
    const { node } = await call('add-log-entry', { nodeId: n.nodeId, text: 'two' });
    expect(node.log.map((l: Any) => l.text)).toEqual(['one', 'two']);
    expect((await failure('add-log-entry', { nodeId: n.nodeId, text: '' })).code).toBe('INVALID_INPUT');
  });
});

// =============================================================================
// States
// =============================================================================

describe('todo — set-state', () => {
  it('follows the human transition table of task-states §7 exactly (cancelled, Pablo 2026-10-30)', () => {
    expect(STATE_TRANSITIONS).toEqual({
      planning: ['pending', 'cancelled'],
      pending: ['working', 'done', 'planning', 'cancelled'],
      working: ['review', 'blocked', 'pending', 'done', 'cancelled'],
      blocked: ['working', 'planning', 'cancelled'],
      review: ['done', 'working', 'cancelled'],
      done: ['working'],
      cancelled: ['pending'],
    });
  });

  for (const from of NODE_STATES) {
    for (const to of NODE_STATES) {
      if (from === to) continue;
      const allowed = STATE_TRANSITIONS[from].includes(to);
      it(`${from} → ${to} is ${allowed ? 'allowed' : 'rejected'}`, async () => {
        await seed({
          nodeId: 'n',
          state: from,
          completed: from === 'done',
          blockedReason: from === 'blocked' ? 'why' : null,
        });
        const body = { nodeId: 'n', state: to, ...(to === 'blocked' ? { reason: 'missing tax ID' } : {}) };
        if (!allowed) {
          const err = await failure('set-state', body);
          expect(err.code).toBe('INVALID_TRANSITION');
          expect((await raw('n')).state).toBe(from);
          return;
        }
        const res = await call('set-state', body);
        expect(res.transition).toEqual({ from, to });
        expect(res.node.state).toBe(to);
        expect(res.node.completed).toBe(to === 'done');
        expect(await raw('n')).toMatchObject({ state: to, completed: to === 'done' });
      });
    }
  }

  it('blocked needs a reason, stores it, and leaving clears it', async () => {
    const n = await add('N');
    await call('set-state', { nodeId: n.nodeId, state: 'working' });
    expect((await failure('set-state', { nodeId: n.nodeId, state: 'blocked' })).code).toBe('REASON_REQUIRED');
    expect((await failure('set-state', { nodeId: n.nodeId, state: 'blocked', reason: '   ' })).code).toBe('REASON_REQUIRED');
    const blocked = await call('set-state', { nodeId: n.nodeId, state: 'blocked', reason: ' missing tax ID ' });
    expect(blocked.node.blockedReason).toBe('missing tax ID');
    expect(await lastLog(n.nodeId)).toBe('working → blocked: missing tax ID');
    const again = await call('set-state', { nodeId: n.nodeId, state: 'blocked', reason: 'still no tax ID' });
    expect(again.node.blockedReason).toBe('still no tax ID');
    expect(await lastLog(n.nodeId)).toBe('Blocked: still no tax ID');
    const resumed = await call('set-state', { nodeId: n.nodeId, state: 'working' });
    expect(resumed.node.blockedReason).toBeNull();
    expect(await lastLog(n.nodeId)).toBe('blocked → working');
  });

  it('done sets progress 100; reopening clears that automatic 100', async () => {
    const n = await add('N');
    await call('set-progress', { nodeId: n.nodeId, progress: 30 });
    const done = await call('set-state', { nodeId: n.nodeId, state: 'done' });
    expect(done.node.reportedProgress).toBe(100);
    const reopened = await call('set-state', { nodeId: n.nodeId, state: 'working', reason: 'missed a step' });
    expect(reopened.node.reportedProgress).toBeNull();
    expect(await lastLog(n.nodeId)).toBe('done → working: missed a step');
  });

  it('review sets progress 100 too; review → done keeps it; review → working clears it', async () => {
    const n = await add('N');
    await call('set-state', { nodeId: n.nodeId, state: 'working' });
    await call('set-progress', { nodeId: n.nodeId, progress: 70 });
    const review = await call('set-state', { nodeId: n.nodeId, state: 'review' });
    expect(review.node.reportedProgress).toBe(100);
    const back = await call('set-state', { nodeId: n.nodeId, state: 'working' });
    expect(back.node.reportedProgress).toBeNull();
    await call('set-state', { nodeId: n.nodeId, state: 'review' });
    const done = await call('set-state', { nodeId: n.nodeId, state: 'done' });
    expect(done.node.reportedProgress).toBe(100);
  });

  it('leaving review/done keeps a progress that is not the automatic 100', async () => {
    const n = await add('N');
    await call('set-state', { nodeId: n.nodeId, state: 'working' });
    await call('set-state', { nodeId: n.nodeId, state: 'review' });
    await call('set-progress', { nodeId: n.nodeId, progress: 90 });
    const back = await call('set-state', { nodeId: n.nodeId, state: 'working' });
    expect(back.node.reportedProgress).toBe(90);
  });

  it('setting the current state is a no-op without a log entry', async () => {
    const n = await add('N');
    const res = await call('set-state', { nodeId: n.nodeId, state: 'pending' });
    expect(res.transition).toEqual({ from: 'pending', to: 'pending' });
    expect((await raw(n.nodeId)).log).toEqual([]);
  });

  it('works on legacy nodes and rejects groups and unknown states', async () => {
    await seed({ nodeId: 'legacy', completed: true });
    expect((await call('set-state', { nodeId: 'legacy', state: 'working' })).transition).toEqual({ from: 'done', to: 'working' });
    const g = await add('G', { kind: 'group' });
    expect((await failure('set-state', { nodeId: g.nodeId, state: 'working' })).code).toBe('NOT_A_TASK');
    expect((await failure('set-state', { nodeId: g.nodeId, state: 'archived' })).code).toBe('INVALID_INPUT');
  });
});

// =============================================================================
// Auto-escalation — a task entering working pulls its pending ancestors in
// =============================================================================

describe('todo — set-state auto-escalation', () => {
  it('a child entering working escalates its pending parent (Auto log)', async () => {
    const p = await add('Parent');
    const c = await add('Child', { parentId: p.nodeId });
    await call('set-state', { nodeId: c.nodeId, state: 'working' });
    expect(await raw(p.nodeId)).toMatchObject({ state: 'working', completed: false });
    expect(await lastLog(p.nodeId)).toBe('Auto: child started working');
    expect(await lastLog(c.nodeId)).toBe('pending → working');
  });

  it('escalates the whole pending chain — a granddaughter wakes two levels', async () => {
    const g = await add('Grand');
    const m = await add('Mid', { parentId: g.nodeId });
    const c = await add('Leaf', { parentId: m.nodeId });
    await call('set-state', { nodeId: c.nodeId, state: 'working' });
    expect(await raw(m.nodeId)).toMatchObject({ state: 'working' });
    expect(await raw(g.nodeId)).toMatchObject({ state: 'working' });
    expect(await lastLog(m.nodeId)).toBe('Auto: child started working');
    expect(await lastLog(g.nodeId)).toBe('Auto: child started working');
  });

  it('leaves a non-pending parent alone (planning, blocked, review, done, working)', async () => {
    for (const parentState of ['planning', 'blocked', 'review', 'done', 'working'] as const) {
      const nodeId = `p_${parentState}`;
      await seed({
        nodeId,
        kind: 'task',
        state: parentState,
        completed: parentState === 'done',
        blockedReason: parentState === 'blocked' ? 'why' : null,
      });
      const c = await add(`Child of ${parentState}`, { parentId: nodeId });
      await call('set-state', { nodeId: c.nodeId, state: 'working' });
      expect(await raw(nodeId)).toMatchObject({ state: parentState });
      expect((await raw(nodeId)).log).toEqual([]);
    }
  });

  it('stops at a group ancestor (groups have no state)', async () => {
    const g = await add('G', { kind: 'group' });
    const c = await add('Child', { parentId: g.nodeId });
    await call('set-state', { nodeId: c.nodeId, state: 'working' });
    expect((await raw(g.nodeId)).state).toBeUndefined();
    expect((await raw(g.nodeId)).log).toEqual([]);
  });

  it('v1: no automatic reverse — a child finishing leaves the parent working', async () => {
    const p = await add('Parent');
    const c = await add('Child', { parentId: p.nodeId });
    await call('set-state', { nodeId: c.nodeId, state: 'working' });
    expect((await raw(p.nodeId)).state).toBe('working');
    await call('set-state', { nodeId: c.nodeId, state: 'done' });
    expect((await raw(p.nodeId)).state).toBe('working');
    expect(await lastLog(p.nodeId)).toBe('Auto: child started working');
  });
});

// =============================================================================
// Kind
// =============================================================================

describe('todo — set-kind', () => {
  it('task → group drops state, reason and progress and logs', async () => {
    const n = await add('N');
    await call('set-progress', { nodeId: n.nodeId, progress: 40 });
    const { node } = await call('set-kind', { nodeId: n.nodeId, kind: 'group' });
    expect(node).toMatchObject({ kind: 'group', state: null, reportedProgress: null, completed: false });
    const stored = await raw(n.nodeId);
    expect(stored.state).toBeUndefined();
    expect(stored.progress).toBeUndefined();
    expect(await lastLog(n.nodeId)).toBe('Converted to group');
  });

  it('group → task starts pending and keeps children', async () => {
    const g = await add('G', { kind: 'group' });
    const child = await add('C', { parentId: g.nodeId });
    const { node } = await call('set-kind', { nodeId: g.nodeId, kind: 'task' });
    expect(node).toMatchObject({ kind: 'task', state: 'pending' });
    expect((await raw(child.nodeId)).parentId).toBe(g.nodeId);
    expect(await lastLog(g.nodeId)).toBe('Converted to task');
  });

  it('enforces "a task cannot contain groups" both ways and refuses to drop an output', async () => {
    const task = await add('Task');
    const sub = await add('Sub', { parentId: task.nodeId });
    expect((await failure('set-kind', { nodeId: sub.nodeId, kind: 'group' })).code).toBe('GROUP_IN_TASK');
    const g = await add('G', { kind: 'group' });
    await add('Inner', { kind: 'group', parentId: g.nodeId });
    expect((await failure('set-kind', { nodeId: g.nodeId, kind: 'task' })).code).toBe('GROUP_IN_TASK');
    await call('set-output', { nodeId: task.nodeId, output: { format: 'markdown', markdown: 'r' } });
    expect((await failure('set-kind', { nodeId: task.nodeId, kind: 'group' })).code).toBe('HAS_OUTPUT');
  });

  it('same kind is a no-op', async () => {
    const n = await add('N');
    expect((await call('set-kind', { nodeId: n.nodeId, kind: 'task' })).node.kind).toBe('task');
    expect((await raw(n.nodeId)).log).toEqual([]);
  });
});

// =============================================================================
// Progress
// =============================================================================

describe('todo — set-progress', () => {
  it('reports and clears progress with log entries', async () => {
    const n = await add('N');
    expect((await call('set-progress', { nodeId: n.nodeId, progress: 40 })).node.reportedProgress).toBe(40);
    expect(await lastLog(n.nodeId)).toBe('Progress 40%');
    expect((await call('set-progress', { nodeId: n.nodeId, progress: null })).node.reportedProgress).toBeNull();
    expect(await lastLog(n.nodeId)).toBe('Progress cleared');
  });

  it('validates the range and rejects groups', async () => {
    const n = await add('N');
    expect((await failure('set-progress', { nodeId: n.nodeId, progress: 101 })).code).toBe('INVALID_INPUT');
    expect((await failure('set-progress', { nodeId: n.nodeId, progress: 2.5 })).code).toBe('INVALID_INPUT');
    expect((await failure('set-progress', { nodeId: n.nodeId })).code).toBe('INVALID_INPUT');
    const g = await add('G', { kind: 'group' });
    expect((await failure('set-progress', { nodeId: g.nodeId, progress: 50 })).code).toBe('NOT_A_TASK');
  });

  // `cancelled` is not in the loop: a cancelled task reports nothing — its
  // stored progress is dropped on cancel and the effective progress reads
  // null (it does not count, Pablo 2026-10-30).
  for (const state of NODE_STATES.filter((s) => s !== 'cancelled')) {
    it(`is editable in state ${state}`, async () => {
      await seed({ nodeId: 's', state, completed: state === 'done', blockedReason: state === 'blocked' ? 'why' : null });
      const res = await call('set-progress', { nodeId: 's', progress: 60 });
      expect(res.node).toMatchObject({ state, reportedProgress: 60 });
      expect((await call('get-node', { nodeId: 's' })).node.progress).toBe(60);
    });
  }

  it('cancelled reports nothing: the stored progress is dropped and the effective one reads null', async () => {
    await seed({ nodeId: 'c', state: 'working' });
    await call('set-progress', { nodeId: 'c', progress: 60 });
    await call('set-state', { nodeId: 'c', state: 'cancelled' });
    const { node } = await call('get-node', { nodeId: 'c' });
    expect(node).toMatchObject({ state: 'cancelled', reportedProgress: null, progress: null, completed: false });
    // A report can still be written (the tool does not refuse), but the
    // effective progress of a cancelled task stays null.
    await call('set-progress', { nodeId: 'c', progress: 30 });
    const after = await call('get-node', { nodeId: 'c' });
    expect(after.node.reportedProgress).toBe(30);
    expect(after.node.progress).toBeNull();
  });

  it('review/done read as 100 when no progress is stored', async () => {
    await seed({ nodeId: 'r', state: 'review' });
    await seed({ nodeId: 'd', state: 'done', completed: true, position: 1 });
    expect((await call('get-tree', {})).tree.map((n: Any) => n.progress)).toEqual([100, 100]);
    await call('set-progress', { nodeId: 'r', progress: null });
    expect((await call('get-node', { nodeId: 'r' })).node.progress).toBe(100);
  });
});

// =============================================================================
// Input / output
// =============================================================================

describe('todo — set-input / set-output', () => {
  const FORM = {
    format: 'form',
    fields: [
      { id: 'taxId', type: 'text', label: 'Tax ID' },
      { id: 'amount', type: 'number', label: 'Amount' },
    ],
    values: { taxId: 'B123' },
  };

  it('stores markdown and form on the node and logs', async () => {
    const n = await add('N');
    const inRes = await call('set-input', { nodeId: n.nodeId, input: FORM });
    expect(inRes.node.input).toEqual(FORM);
    expect(inRes.node.hasInput).toBe(true);
    expect(await lastLog(n.nodeId)).toBe('Input set · form');
    const outRes = await call('set-output', { nodeId: n.nodeId, output: { format: 'markdown', markdown: '# Done' } });
    expect(outRes.node.output).toEqual({ format: 'markdown', markdown: '# Done' });
    expect(await lastLog(n.nodeId)).toBe('Output delivered · markdown');
    const { node } = await call('get-node', { nodeId: n.nodeId });
    expect(node.input).toEqual(FORM);
    expect(node.output).toEqual({ format: 'markdown', markdown: '# Done' });
  });

  it('clears with null', async () => {
    const n = await add('N');
    await call('set-output', { nodeId: n.nodeId, output: { format: 'markdown', markdown: 'x' } });
    const res = await call('set-output', { nodeId: n.nodeId, output: null });
    expect(res.node).toMatchObject({ output: null, hasOutput: false });
    expect(await lastLog(n.nodeId)).toBe('Output cleared');
    await call('set-input', { nodeId: n.nodeId, input: null });
    expect(await lastLog(n.nodeId)).toBe('Input cleared');
  });

  it('validates forms: field types, duplicate ids, values without a field', async () => {
    const n = await add('N');
    const badType = { ...FORM, fields: [{ id: 'x', type: 'color', label: 'X' }] };
    expect((await failure('set-input', { nodeId: n.nodeId, input: badType })).code).toBe('INVALID_INPUT');
    const dup = { ...FORM, fields: [FORM.fields[0], FORM.fields[0]] };
    expect((await failure('set-input', { nodeId: n.nodeId, input: dup })).message).toContain('Duplicate form field id');
    const orphan = { ...FORM, values: { nope: 1 } };
    expect((await failure('set-input', { nodeId: n.nodeId, input: orphan })).message).toContain('no matching field');
    expect((await failure('set-input', { nodeId: n.nodeId, input: { format: 'html', html: '' } })).code).toBe('INVALID_INPUT');
  });

  it('uploads a file output to object storage and stores the reference', async () => {
    const n = await add('Invoice');
    const content = 'hello invoice';
    const res = await call('set-output', {
      nodeId: n.nodeId,
      output: { format: 'file', name: 'invoice.txt', mime: 'text/plain', data: Buffer.from(content).toString('base64') },
    });
    const out = res.node.output;
    expect(out).toMatchObject({ format: 'file', name: 'invoice.txt', mime: 'text/plain', size: content.length });
    expect(out.objectId).toMatch(/^obj_[a-f0-9]{16}$/);
    expect(out.url).toEndWith(`/objects/${out.objectId}`);
    expect(out.data).toBeUndefined();

    const obj = await db.collection('agent_app_objects').findOne({ objectId: out.objectId });
    expect(obj).toMatchObject({
      installationId: APP,
      contentType: 'text/plain',
      size: content.length,
      metadata: { workspaceId: WS, nodeId: n.nodeId, slot: 'output', name: 'invoice.txt' },
    });
    expect(await fs.readFile(obj!.path, 'utf8')).toBe(content);
    expect(await lastLog(n.nodeId)).toBe('Output delivered · file invoice.txt');
    expect((await raw(n.nodeId)).output).toEqual(out);
  });

  it('rejects oversized and non-base64 files without storing anything', async () => {
    const n = await add('N');
    const big = Buffer.alloc(MAX_IO_FILE_BYTES + 3).toString('base64');
    const tooBig = await failure('set-output', { nodeId: n.nodeId, output: { format: 'file', name: 'a', mime: 'x/y', data: big } });
    expect(tooBig.code).toBe('INVALID_INPUT');
    const notB64 = await failure('set-output', {
      nodeId: n.nodeId,
      output: { format: 'file', name: 'a', mime: 'x/y', data: 'data:text/plain;base64,aGk=' },
    });
    expect(notB64.code).toBe('INVALID_INPUT');
    expect(await db.collection('agent_app_objects').countDocuments()).toBe(0);
  });

  it('groups take input but no output', async () => {
    const g = await add('G', { kind: 'group' });
    expect((await call('set-input', { nodeId: g.nodeId, input: { format: 'markdown', markdown: 'ctx' } })).node.hasInput).toBe(true);
    expect((await failure('set-output', { nodeId: g.nodeId, output: { format: 'markdown', markdown: 'x' } })).code).toBe('NOT_A_TASK');
  });
});

// =============================================================================
// set-input / set-output — path-delivered files + overwrite protection
// (roadmap incident, 28-oct: a truncated base64 upload fell back to markdown
// and silently replaced a delivered HTML file)
// =============================================================================

describe('todo — set-input / set-output: path + overwrite', () => {
  const VOL_ID = 'vol_todo_path_1';
  // VolumeService.getVolume asserts the volume's hostPath is inside its
  // basePath — seed the volume in the production layout
  // basePath/workspaces/<volumeId>, exactly as the real WorkspaceService does.
  const VOLS_BASE = join(tmpdir(), `todo-vols-${Date.now()}`);
  const volumeHostPath = join(VOLS_BASE, 'workspaces', VOL_ID);
  let previousDeps: Partial<Record<string, unknown>>;

  beforeAll(async () => {
    await fs.mkdir(volumeHostPath, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(VOLS_BASE, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // A workspace whose volume hostPath is the throwaway dir. resolveVolumeHostPath
    // maps '/workspace/<rel>' → join(hostPath, '<rel>').
    await db.collection('volumes').deleteMany({});
    await db.collection('workspaces').deleteMany({});
    await db.collection('volumes').insertOne({
      volumeId: VOL_ID,
      name: 'todo path test',
      hostPath: volumeHostPath,
      ownerId: WS,
      quota: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('workspaces').insertOne({
      workspaceId: WS,
      ownerId: 'user_owner',
      name: 'WS',
      status: 'active',
      volumeId: VOL_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // The todo capability reads the volume through the injected services.
    const { setMcaActionDeps, getMcaActionDeps } = await import('../../src/mca-actions');
    previousDeps = { ...getMcaActionDeps() } as Partial<Record<string, unknown>>;
    const { VolumeService } = await import('../../src/services/volume-service');
    const { WorkspaceService } = await import('../../src/services/workspace-service');
    const volumeService = new VolumeService(db, { basePath: VOLS_BASE });
    const workspaceService = new WorkspaceService(db, volumeService);
    setMcaActionDeps({ volumeService, workspaceService } as any);
  });

  afterEach(async () => {
    // Restore whatever the rest of the suite expects (no volume deps).
    const { setMcaActionDeps } = await import('../../src/mca-actions');
    setMcaActionDeps(previousDeps as any);
  });

  const HTML = '<html><body><h1>Roadmap</h1></body></html>';

  async function writeFile(rel: string, content: string): Promise<string> {
    const abs = join(volumeHostPath, rel);
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
    return `/workspace/${rel}`;
  }

  it('uploads a path-delivered file from the workspace volume (name/mime inferred)', async () => {
    const n = await add('Roadmap');
    const path = await writeFile('roadmap/roadmap-draft-v2.html', HTML);
    const res = await call('set-output', { nodeId: n.nodeId, output: { format: 'file', path } });
    const out = res.node.output;
    expect(out).toMatchObject({ format: 'file', name: 'roadmap-draft-v2.html', mime: 'text/html', size: HTML.length });
    expect(out.objectId).toMatch(/^obj_[a-f0-9]{16}$/);
    const obj = await db.collection('agent_app_objects').findOne({ objectId: out.objectId });
    expect(obj).toMatchObject({
      installationId: APP,
      contentType: 'text/html',
      size: HTML.length,
      metadata: { workspaceId: WS, nodeId: n.nodeId, slot: 'output', name: 'roadmap-draft-v2.html' },
    });
    expect(await fs.readFile(obj!.path, 'utf8')).toBe(HTML);
    expect(await lastLog(n.nodeId)).toBe('Output delivered · file roadmap-draft-v2.html');
  });

  it('rejects a path outside the workspace volume mount and a path that does not exist', async () => {
    const n = await add('N');
    const outside = await failure('set-output', { nodeId: n.nodeId, output: { format: 'file', path: '/etc/passwd' } });
    expect(outside.code).toBe('INVALID_INPUT');
    expect(outside.message).toContain('/etc/passwd');
    const missing = await failure('set-output', {
      nodeId: n.nodeId,
      output: { format: 'file', path: '/workspace/roadmap/nope.html' },
    });
    expect(missing.code).toBe('FILE_NOT_FOUND');
    expect(missing.message).toContain('nope.html');
    expect(await db.collection('agent_app_objects').countDocuments()).toBe(0);
  });

  it('still accepts base64 data (retrocompatible), and rejects data+path and neither', async () => {
    const n = await add('Invoice');
    const res = await call('set-output', {
      nodeId: n.nodeId,
      output: { format: 'file', name: 'invoice.txt', mime: 'text/plain', data: Buffer.from('hi').toString('base64') },
    });
    expect(res.node.output).toMatchObject({ format: 'file', name: 'invoice.txt', mime: 'text/plain', size: 2 });
    const both = await failure('set-output', {
      nodeId: n.nodeId,
      output: { format: 'file', path: '/workspace/x.txt', name: 'x', mime: 't/t', data: 'aGk=' },
      overwrite: true,
    });
    expect(both.code).toBe('INVALID_INPUT');
    expect(both.message).toContain('not both');
    const neither = await failure('set-output', { nodeId: n.nodeId, output: { format: 'file', name: 'x', mime: 't/t' } });
    expect(neither.code).toBe('INVALID_INPUT');
  });

  it('refuses to replace an existing output without overwrite: true (OUTPUT_EXISTS)', async () => {
    const n = await add('Roadmap');
    const path = await writeFile('roadmap/roadmap-draft-v2.html', HTML);
    await call('set-output', { nodeId: n.nodeId, output: { format: 'file', path } });
    const before = await raw(n.nodeId);

    // The incident: a fallback markdown silently replacing the delivered file.
    const refused = await failure('set-output', {
      nodeId: n.nodeId,
      output: { format: 'markdown', markdown: 'see roadmap-draft-v2.html' },
    });
    expect(refused.code).toBe('OUTPUT_EXISTS');
    expect(refused.message).toContain('file roadmap-draft-v2.html');
    expect(refused.message).toContain('overwrite: true');
    expect(refused.suggestion).toContain('get-node');

    // Nothing was stored, nothing was logged, the file output is intact.
    const after = await raw(n.nodeId);
    expect(after.output).toEqual(before.output);
    expect(after.log.length).toBe(before.log.length);
    expect((await db.collection('agent_app_objects').find({ 'metadata.nodeId': n.nodeId }).toArray()).length).toBe(1);
  });

  it('overwrite: true replaces the output and logs the change', async () => {
    const n = await add('Roadmap');
    const v1 = await writeFile('roadmap/v1.html', '<p>v1</p>');
    await call('set-output', { nodeId: n.nodeId, output: { format: 'file', path: v1 } });
    const v2 = await writeFile('roadmap/v2.html', '<p>v2</p>');
    const res = await call('set-output', { nodeId: n.nodeId, output: { format: 'file', path: v2 }, overwrite: true });
    expect(res.node.output).toMatchObject({ name: 'v2.html', size: 9 });
    expect(await lastLog(n.nodeId)).toBe('Output delivered · file v2.html');
  });

  it('identical re-delivery is a no-op without overwrite (markdown text, form field ids)', async () => {
    const n = await add('N');
    await call('set-output', { nodeId: n.nodeId, output: { format: 'markdown', markdown: 'same' } });
    const before = await raw(n.nodeId);
    const res = await call('set-output', { nodeId: n.nodeId, output: { format: 'markdown', markdown: 'same' } });
    expect(res.node.output).toEqual({ format: 'markdown', markdown: 'same' });
    const after = await raw(n.nodeId);
    expect(after.log.length).toBe(before.log.length); // no new entry
    // Form: same field ids, different values — a human filling it in over time.
    const FORM = { format: 'form', fields: [{ id: 'a', type: 'text', label: 'A' }], values: {} } as const;
    const f = await add('F');
    await call('set-output', { nodeId: f.nodeId, output: FORM });
    const fBefore = await raw(f.nodeId);
    await call('set-output', { nodeId: f.nodeId, output: { ...FORM, values: { a: 'filled' } } });
    const fAfter = await raw(f.nodeId);
    expect(fAfter.output.values).toEqual({ a: 'filled' });
    expect(fAfter.log.length).toBe(fBefore.log.length);
  });

  it('applies the same protection to set-input', async () => {
    const n = await add('N');
    await call('set-input', { nodeId: n.nodeId, input: { format: 'markdown', markdown: 'ctx' } });
    const refused = await failure('set-input', { nodeId: n.nodeId, input: { format: 'markdown', markdown: 'other' } });
    expect(refused.code).toBe('OUTPUT_EXISTS');
    expect(refused.message).toContain('an input');
    const res = await call('set-input', {
      nodeId: n.nodeId,
      input: { format: 'markdown', markdown: 'other' },
      overwrite: true,
    });
    expect(res.node.input).toEqual({ format: 'markdown', markdown: 'other' });
  });
});

// =============================================================================
// Instructions checklist
// =============================================================================

describe('todo — toggle-instruction-item', () => {
  const INSTRUCTIONS = [
    'Steps:',
    '- [ ] gather invoices',
    '```',
    '- [ ] not an item (code)',
    '```',
    '* [x] email the accountant',
    '1. [ ] file the return',
    '',
    'Done when:',
    '- [ ] receipt received',
  ].join('\n');

  it('toggles the index-th checkbox, skipping code fences', async () => {
    const n = await add('N', { instructions: INSTRUCTIONS });
    const first = await call('toggle-instruction-item', { nodeId: n.nodeId, index: 0 });
    expect(first.item).toEqual({ index: 0, checked: true, text: 'gather invoices' });
    expect(first.node.instructions.split('\n')[1]).toBe('- [x] gather invoices');
    expect(first.node.instructions.split('\n')[3]).toBe('- [ ] not an item (code)');

    const second = await call('toggle-instruction-item', { nodeId: n.nodeId, index: 1 });
    expect(second.item).toEqual({ index: 1, checked: false, text: 'email the accountant' });
    expect(second.node.instructions.split('\n')[5]).toBe('* [ ] email the accountant');

    const third = await call('toggle-instruction-item', { nodeId: n.nodeId, index: 2 });
    expect(third.node.instructions.split('\n')[6]).toBe('1. [x] file the return');
    const last = await call('toggle-instruction-item', { nodeId: n.nodeId, index: 3 });
    expect(last.item.text).toBe('receipt received');
  });

  it('fails ITEM_NOT_FOUND past the last item', async () => {
    const n = await add('N', { instructions: INSTRUCTIONS });
    expect((await failure('toggle-instruction-item', { nodeId: n.nodeId, index: 4 })).code).toBe('ITEM_NOT_FOUND');
    expect((await failure('toggle-instruction-item', { nodeId: n.nodeId, index: -1 })).code).toBe('INVALID_INPUT');
    expect((await raw(n.nodeId)).instructions).toBe(INSTRUCTIONS);
  });
});

describe('todo — plan-node', () => {
  const D = '2026-10-24';
  const D2 = '2026-10-25';

  async function dayOrderOf(day: string): Promise<string[]> {
    const list = await db
      .collection('todo_nodes')
      .find({ workspaceId: WS, plannedFor: day })
      .sort({ dayOrder: 1 })
      .toArray();
    return list.map((n) => `${n.text}:${n.dayOrder}`);
  }

  it('plans a task at the end of a day and logs it', async () => {
    const a = await add('A');
    const b = await add('B');
    await call('plan-node', { nodeId: a.nodeId, day: D });
    const res = await call('plan-node', { nodeId: b.nodeId, day: D, time: '09:00' });
    expect(res.node).toMatchObject({ plannedFor: D, dayOrder: 1, plannedTime: '09:00' });
    expect(res.previousDay).toBeNull();
    expect(await dayOrderOf(D)).toEqual(['A:0', 'B:1']);
    expect(await lastLog(b.nodeId)).toBe(`Planned for ${D} at 09:00`);
    expect(await lastLog(a.nodeId)).toBe(`Planned for ${D}`);
  });

  it('inserts at an index and renumbers the day; reorder logs nothing', async () => {
    const a = await add('A');
    const b = await add('B');
    const c = await add('C');
    for (const n of [a, b, c]) await call('plan-node', { nodeId: n.nodeId, day: D });
    const logs = (await raw(c.nodeId)).log.length;
    await call('plan-node', { nodeId: c.nodeId, day: D, index: 0 });
    expect(await dayOrderOf(D)).toEqual(['C:0', 'A:1', 'B:2']);
    expect((await raw(c.nodeId)).log.length).toBe(logs);
    await call('plan-node', { nodeId: c.nodeId, day: D, index: 99 });
    expect(await dayOrderOf(D)).toEqual(['A:0', 'B:1', 'C:2']);
  });

  it('moving to another day renumbers the day it left and keeps the time', async () => {
    const a = await add('A');
    const b = await add('B');
    const c = await add('C');
    for (const n of [a, b, c]) await call('plan-node', { nodeId: n.nodeId, day: D });
    await call('plan-node', { nodeId: a.nodeId, day: D, time: '10:30' });
    expect(await lastLog(a.nodeId)).toBe('Planned time 10:30');
    const res = await call('plan-node', { nodeId: a.nodeId, day: D2 });
    expect(res.previousDay).toBe(D);
    expect(res.node).toMatchObject({ plannedFor: D2, dayOrder: 0, plannedTime: '10:30' });
    expect(await dayOrderOf(D)).toEqual(['B:0', 'C:1']);
  });

  it('day null removes it from the day, clears the time and renumbers', async () => {
    const a = await add('A');
    const b = await add('B');
    await call('plan-node', { nodeId: a.nodeId, day: D, time: '08:00' });
    await call('plan-node', { nodeId: b.nodeId, day: D });
    const res = await call('plan-node', { nodeId: a.nodeId, day: null });
    expect(res.node).toMatchObject({ plannedFor: null, dayOrder: null, plannedTime: null });
    expect(await lastLog(a.nodeId)).toBe('Removed from the day');
    expect(await dayOrderOf(D)).toEqual(['B:0']);
    // Unplanning an unplanned task is a no-op (no log).
    const before = (await raw(a.nodeId)).log.length;
    await call('plan-node', { nodeId: a.nodeId, day: null });
    expect((await raw(a.nodeId)).log.length).toBe(before);
  });

  it('time null clears only the time', async () => {
    const a = await add('A');
    await call('plan-node', { nodeId: a.nodeId, day: D, time: '08:00' });
    const res = await call('plan-node', { nodeId: a.nodeId, day: D, time: null });
    expect(res.node).toMatchObject({ plannedFor: D, plannedTime: null });
    expect(await lastLog(a.nodeId)).toBe('Planned time cleared');
  });

  it('rejects groups, bad days and bad times', async () => {
    const g = await add('G', { kind: 'group' });
    expect((await failure('plan-node', { nodeId: g.nodeId, day: D })).code).toBe('NOT_A_TASK');
    const a = await add('A');
    expect((await failure('plan-node', { nodeId: a.nodeId, day: '2026-02-30' })).code).toBe('INVALID_INPUT');
    expect((await failure('plan-node', { nodeId: a.nodeId, day: '24/10/2026' })).code).toBe('INVALID_INPUT');
    expect((await failure('plan-node', { nodeId: a.nodeId, day: D, time: '25:00' })).code).toBe('INVALID_INPUT');
    expect((await failure('plan-node', { nodeId: 'tn_missing', day: D })).code).toBe('NOT_FOUND');
  });

  it('is scoped to the workspace', async () => {
    const a = await add('A');
    expect((await failure('plan-node', { nodeId: a.nodeId, day: D }, otherCtx)).code).toBe('NOT_FOUND');
  });

  it('get-tree, get-node and set-kind expose / drop the plan fields', async () => {
    const a = await add('A');
    await call('plan-node', { nodeId: a.nodeId, day: D, time: '09:15' });
    const tree = (await call('get-tree')).tree;
    expect(tree[0]).toMatchObject({ plannedFor: D, dayOrder: 0, plannedTime: '09:15' });
    expect((await call('get-node', { nodeId: a.nodeId })).node).toMatchObject({ plannedFor: D, plannedTime: '09:15' });
    const g = (await call('set-kind', { nodeId: a.nodeId, kind: 'group' })).node;
    expect(g).toMatchObject({ plannedFor: null, dayOrder: null, plannedTime: null });
    const stored = await raw(a.nodeId);
    expect(stored.plannedFor).toBeUndefined();
  });
});

describe('todo — get-day', () => {
  const TODAY = '2026-10-24';

  it('lists the day in plan order, overdue open tasks and unplanned open tasks', async () => {
    const home = await add('Home', { kind: 'group' });
    const house = await add('House', { kind: 'group', parentId: home.nodeId });
    const t1 = await add('Insurance', { parentId: house.nodeId });
    const t2 = await add('Blind', { parentId: house.nodeId });
    const late = await add('Expenses', { parentId: home.nodeId });
    const lateDone = await add('Old done', { parentId: home.nodeId });
    const free = await add('Unplanned');
    const freeDone = await add('Unplanned done', { state: 'done' });

    await call('plan-node', { nodeId: t2.nodeId, day: TODAY });
    await call('plan-node', { nodeId: t1.nodeId, day: TODAY, index: 0, time: '18:30' });
    await call('plan-node', { nodeId: late.nodeId, day: '2026-10-23' });
    await call('plan-node', { nodeId: lateDone.nodeId, day: '2026-10-22' });
    await call('toggle-complete', { nodeId: lateDone.nodeId });

    const res = await call('get-day', { day: TODAY, today: TODAY });
    expect(res.day).toBe(TODAY);
    expect(res.today).toBe(TODAY);
    expect(res.tasks.map((t: Any) => t.text)).toEqual(['Insurance', 'Blind']);
    expect(res.tasks[0]).toMatchObject({ state: 'pending', plannedTime: '18:30', dayOrder: 0, path: ['Home', 'House'] });
    expect(res.overdue.map((t: Any) => t.text)).toEqual(['Expenses']);
    expect(res.unplanned.map((t: Any) => t.text)).toEqual(['Unplanned']);
    expect(res.unplanned.map((t: Any) => t.nodeId)).not.toContain(freeDone.nodeId);
    expect(res.unplanned[0].path).toEqual([]);
    expect(free.nodeId).toBeTruthy();
  });

  it('overdue is relative to today; another day lists its own plan', async () => {
    const a = await add('A');
    await call('plan-node', { nodeId: a.nodeId, day: '2026-10-25' });
    const res = await call('get-day', { day: '2026-10-25', today: '2026-10-26' });
    expect(res.tasks.map((t: Any) => t.text)).toEqual(['A']);
    expect(res.overdue.map((t: Any) => t.text)).toEqual(['A']);
    const before = await call('get-day', { day: '2026-10-25', today: '2026-10-24' });
    expect(before.overdue).toEqual([]);
  });

  it('a cancelled task leaves the day plan: not listed, not overdue, not unplanned (Pablo 2026-10-30)', async () => {
    const planned = await add('Planned');
    const late = await add('Late');
    const free = await add('Free');
    await call('plan-node', { nodeId: planned.nodeId, day: TODAY });
    await call('plan-node', { nodeId: late.nodeId, day: '2026-10-23' });
    await call('set-state', { nodeId: planned.nodeId, state: 'cancelled' });
    await call('set-state', { nodeId: late.nodeId, state: 'cancelled' });
    await call('set-state', { nodeId: free.nodeId, state: 'cancelled' });
    const res = await call('get-day', { day: TODAY, today: TODAY });
    expect(res.tasks.map((t: Any) => t.text)).toEqual([]);
    expect(res.overdue).toEqual([]);
    expect(res.unplanned).toEqual([]);
    // The plan fields are cleared on the node itself.
    expect(await raw(planned.nodeId)).toMatchObject({ state: 'cancelled', plannedFor: null, plannedTime: null });
  });

  it('cancelling logs the transition and reopening goes to pending with a log', async () => {
    const n = await add('N');
    await call('set-state', { nodeId: n.nodeId, state: 'working' });
    const cancelled = await call('set-state', { nodeId: n.nodeId, state: 'cancelled' });
    expect(cancelled.transition).toEqual({ from: 'working', to: 'cancelled' });
    expect(cancelled.node.completed).toBe(false);
    expect(await lastLog(n.nodeId)).toBe('working → cancelled');
    const reopened = await call('set-state', { nodeId: n.nodeId, state: 'pending' });
    expect(reopened.transition).toEqual({ from: 'cancelled', to: 'pending' });
    expect(reopened.node.state).toBe('pending');
    expect(await lastLog(n.nodeId)).toBe('cancelled → pending');
  });

  it('a cancelled child does not count for the parent progress (like an empty group)', async () => {
    const parent = await add('Parent');
    const a = await add('A', { parentId: parent.nodeId });
    const b = await add('B', { parentId: parent.nodeId });
    await call('toggle-complete', { nodeId: a.nodeId }); // 100
    await call('set-state', { nodeId: b.nodeId, state: 'cancelled' }); // no contribution
    // Parent = mean(100) = 100 — the cancelled child neither blocks nor counts 0.
    expect((await call('get-node', { nodeId: parent.nodeId })).node.progress).toBe(100);
  });

  it('carries the effective progress (review purple at 100)', async () => {
    const a = await add('A', { state: 'working' });
    await call('set-progress', { nodeId: a.nodeId, progress: 40 });
    await call('plan-node', { nodeId: a.nodeId, day: TODAY });
    const b = await add('B', { state: 'working' });
    await call('set-state', { nodeId: b.nodeId, state: 'review' });
    await call('plan-node', { nodeId: b.nodeId, day: TODAY });
    const res = await call('get-day', { day: TODAY, today: TODAY });
    expect(res.tasks.map((t: Any) => [t.text, t.state, t.progress])).toEqual([
      ['A', 'working', 40],
      ['B', 'review', 100],
    ]);
  });

  it('validates the day and is scoped to the workspace', async () => {
    expect((await failure('get-day', { day: 'tomorrow' })).code).toBe('INVALID_INPUT');
    const a = await add('A');
    await call('plan-node', { nodeId: a.nodeId, day: TODAY });
    const other = await call('get-day', { day: TODAY, today: TODAY }, otherCtx);
    expect(other.tasks).toEqual([]);
  });
});

describe('todo — assign-node', () => {
  beforeEach(async () => {
    await db.collection('workspaces').insertMany([
      { workspaceId: WS, ownerId: 'user_owner', name: 'Private', status: 'active' },
      { workspaceId: OTHER_WS, ownerId: 'user_other', name: 'Other', status: 'active' },
    ]);
    await db.collection('workspace_members').insertMany([
      { workspaceId: WS, userId: 'user_member', role: 'write', status: 'active' },
      { workspaceId: WS, userId: 'user_pending', role: 'write', status: 'pending' },
      { workspaceId: OTHER_WS, userId: 'user_outsider', role: 'write' },
    ]);
    await db.collection('users').insertMany([
      { userId: 'user_owner', profile: { displayName: 'Pablo' } },
      { userId: 'user_member', profile: { displayName: 'Alice' } },
    ]);
    await db.collection('agents').insertMany([
      { agentId: 'agent_ws', name: 'Nira', workspaceId: WS, ownerId: 'user_owner' },
      { agentId: 'agent_other', name: 'Ops', workspaceId: OTHER_WS, ownerId: 'user_other' },
      { agentId: 'agent_super', name: 'Iria', workspaceId: null, ownerId: 'user_member' },
      { agentId: 'agent_super_out', name: 'Eve', workspaceId: null, ownerId: 'user_outsider' },
    ]);
  });

  it('assigns an agent of the workspace, stores assignedAt and logs the name', async () => {
    const t = await add('Factura');
    const res = await call('assign-node', { nodeId: t.nodeId, assignee: { kind: 'agent', id: 'agent_ws' } });
    expect(res.node.assignee).toEqual({ kind: 'agent', id: 'agent_ws' });
    expect(typeof res.node.assignedAt).toBe('number');
    expect(await lastLog(t.nodeId)).toBe('Assigned to Nira');
  });

  it('assigns the owner or an active member; refuses pending members and outsiders', async () => {
    const t = await add('T');
    await call('assign-node', { nodeId: t.nodeId, assignee: { kind: 'user', id: 'user_owner' } });
    expect(await lastLog(t.nodeId)).toBe('Assigned to Pablo');
    await call('assign-node', { nodeId: t.nodeId, assignee: { kind: 'user', id: 'user_member' } });
    expect(await lastLog(t.nodeId)).toBe('Assigned to Alice');
    for (const id of ['user_pending', 'user_outsider', 'user_ghost']) {
      expect((await failure('assign-node', { nodeId: t.nodeId, assignee: { kind: 'user', id } })).code).toBe('INVALID_ASSIGNEE');
    }
  });

  it("accepts members' personal agents and refuses other workspaces' agents", async () => {
    const t = await add('T');
    await call('assign-node', { nodeId: t.nodeId, assignee: { kind: 'agent', id: 'agent_super' } });
    expect(await lastLog(t.nodeId)).toBe('Assigned to Iria');
    for (const id of ['agent_other', 'agent_super_out', 'agent_ghost']) {
      expect((await failure('assign-node', { nodeId: t.nodeId, assignee: { kind: 'agent', id } })).code).toBe('INVALID_ASSIGNEE');
    }
  });

  it('unassigns, is idempotent and refuses groups', async () => {
    const t = await add('T');
    await call('assign-node', { nodeId: t.nodeId, assignee: { kind: 'agent', id: 'agent_ws' } });
    const logs = (await raw(t.nodeId)).log.length;
    await call('assign-node', { nodeId: t.nodeId, assignee: { kind: 'agent', id: 'agent_ws' } });
    expect((await raw(t.nodeId)).log.length).toBe(logs);
    const res = await call('assign-node', { nodeId: t.nodeId, assignee: null });
    expect(res.node.assignee).toBeNull();
    expect(res.node.assignedAt).toBeNull();
    expect(await lastLog(t.nodeId)).toBe('Unassigned');
    const g = await add('G', { kind: 'group' });
    expect((await failure('assign-node', { nodeId: g.nodeId, assignee: null })).code).toBe('NOT_A_TASK');
    expect((await failure('assign-node', { nodeId: t.nodeId, assignee: { kind: 'robot', id: 'x' } })).code).toBe('INVALID_INPUT');
  });

  it('is scoped to the workspace', async () => {
    const t = await add('T');
    expect((await failure('assign-node', { nodeId: t.nodeId, assignee: null }, otherCtx)).code).toBe('NOT_FOUND');
  });

  it('get-tree / get-node / get-day expose it; get-tree filters by assignee; set-kind drops it', async () => {
    const g = await add('Home', { kind: 'group' });
    const mine = await add('Mine', { parentId: g.nodeId });
    await add('Other', { parentId: g.nodeId });
    await add('Loose');
    await call('assign-node', { nodeId: mine.nodeId, assignee: { kind: 'user', id: 'user_owner' } });
    await call('plan-node', { nodeId: mine.nodeId, day: '2026-10-24' });
    const full = (await call('get-tree')).tree;
    expect(full.find((n: Any) => n.text === 'Home').children.find((k: Any) => k.text === 'Mine').assignee).toEqual({ kind: 'user', id: 'user_owner' });
    const filtered = (await call('get-tree', { assignee: { kind: 'user', id: 'user_owner' } })).tree;
    expect(filtered.map((n: Any) => n.text)).toEqual(['Home']);
    expect(filtered[0].children.map((n: Any) => n.text)).toEqual(['Mine']);
    expect((await call('get-node', { nodeId: mine.nodeId })).node.assignee).toEqual({ kind: 'user', id: 'user_owner' });
    const day = await call('get-day', { day: '2026-10-24', today: '2026-10-24' });
    expect(day.tasks[0].assignee).toEqual({ kind: 'user', id: 'user_owner' });
    await call('set-kind', { nodeId: mine.nodeId, kind: 'group' });
    expect((await raw(mine.nodeId)).assignee).toBeUndefined();
  });
});

describe('todo — set-reviewer (TODORV)', () => {
  beforeEach(async () => {
    await db.collection('workspaces').insertMany([
      { workspaceId: WS, ownerId: 'user_owner', name: 'Private', status: 'active' },
      { workspaceId: OTHER_WS, ownerId: 'user_other', name: 'Other', status: 'active' },
    ]);
    await db.collection('workspace_members').insertMany([
      { workspaceId: WS, userId: 'user_member', role: 'write', status: 'active' },
      { workspaceId: WS, userId: 'user_pending', role: 'write', status: 'pending' },
      { workspaceId: OTHER_WS, userId: 'user_outsider', role: 'write' },
    ]);
    await db.collection('users').insertMany([
      { userId: 'user_owner', profile: { displayName: 'Pablo' } },
      { userId: 'user_member', profile: { displayName: 'Alice' } },
    ]);
    await db.collection('agents').insertMany([
      { agentId: 'agent_ws', name: 'Nira', workspaceId: WS, ownerId: 'user_owner' },
      { agentId: 'agent_other', name: 'Ops', workspaceId: OTHER_WS, ownerId: 'user_other' },
      { agentId: 'agent_super', name: 'Iria', workspaceId: null, ownerId: 'user_member' },
    ]);
  });

  it('sets an agent reviewer, stores reviewedAt and logs the name', async () => {
    const t = await add('Factura');
    const res = await call('set-reviewer', { nodeId: t.nodeId, reviewer: { kind: 'agent', id: 'agent_ws' } });
    expect(res.node.reviewer).toEqual({ kind: 'agent', id: 'agent_ws' });
    expect(typeof res.node.reviewedAt).toBe('number');
    expect(await lastLog(t.nodeId)).toBe('Reviewer set to Nira');
  });

  it('accepts the owner, an active member and their personal agents; refuses everyone else', async () => {
    const t = await add('T');
    await call('set-reviewer', { nodeId: t.nodeId, reviewer: { kind: 'user', id: 'user_owner' } });
    expect(await lastLog(t.nodeId)).toBe('Reviewer set to Pablo');
    await call('set-reviewer', { nodeId: t.nodeId, reviewer: { kind: 'user', id: 'user_member' } });
    expect(await lastLog(t.nodeId)).toBe('Reviewer set to Alice');
    await call('set-reviewer', { nodeId: t.nodeId, reviewer: { kind: 'agent', id: 'agent_super' } });
    expect(await lastLog(t.nodeId)).toBe('Reviewer set to Iria');
    for (const r of [
      { kind: 'user', id: 'user_pending' },
      { kind: 'user', id: 'user_outsider' },
      { kind: 'user', id: 'user_ghost' },
      { kind: 'agent', id: 'agent_other' },
      { kind: 'agent', id: 'agent_ghost' },
    ]) {
      expect((await failure('set-reviewer', { nodeId: t.nodeId, reviewer: r })).code).toBe('INVALID_ASSIGNEE');
    }
  });

  it('clears, is idempotent and refuses groups', async () => {
    const t = await add('T');
    await call('set-reviewer', { nodeId: t.nodeId, reviewer: { kind: 'agent', id: 'agent_ws' } });
    const logs = (await raw(t.nodeId)).log.length;
    await call('set-reviewer', { nodeId: t.nodeId, reviewer: { kind: 'agent', id: 'agent_ws' } });
    expect((await raw(t.nodeId)).log.length).toBe(logs);
    const res = await call('set-reviewer', { nodeId: t.nodeId, reviewer: null });
    expect(res.node.reviewer).toBeNull();
    expect(res.node.reviewedAt).toBeNull();
    expect(await lastLog(t.nodeId)).toBe('Reviewer removed');
    const g = await add('G', { kind: 'group' });
    expect((await failure('set-reviewer', { nodeId: g.nodeId, reviewer: null })).code).toBe('NOT_A_TASK');
    expect((await failure('set-reviewer', { nodeId: t.nodeId, reviewer: { kind: 'robot', id: 'x' } })).code).toBe('INVALID_INPUT');
  });

  it('is scoped to the workspace', async () => {
    const t = await add('T');
    expect((await failure('set-reviewer', { nodeId: t.nodeId, reviewer: null }, otherCtx)).code).toBe('NOT_FOUND');
  });

  it('empty by default: reads expose null and set-kind drops it', async () => {
    const t = await add('Fresh');
    expect((await raw(t.nodeId)).reviewer).toBeUndefined();
    expect((await call('get-node', { nodeId: t.nodeId })).node.reviewer).toBeNull();
    const tree = (await call('get-tree')).tree;
    expect(tree[0].reviewer).toBeNull();
    await call('set-reviewer', { nodeId: t.nodeId, reviewer: { kind: 'user', id: 'user_owner' } });
    await call('set-kind', { nodeId: t.nodeId, kind: 'group' });
    expect((await raw(t.nodeId)).reviewer).toBeUndefined();
  });

  it('get-tree filters by reviewer (matching tasks plus the path to them)', async () => {
    const g = await add('Home', { kind: 'group' });
    const watched = await add('Watched', { parentId: g.nodeId });
    await add('Other', { parentId: g.nodeId });
    await add('Loose');
    await call('set-reviewer', { nodeId: watched.nodeId, reviewer: { kind: 'user', id: 'user_owner' } });
    const filtered = (await call('get-tree', { reviewer: { kind: 'user', id: 'user_owner' } })).tree;
    expect(filtered.map((n: Any) => n.text)).toEqual(['Home']);
    expect(filtered[0].children.map((n: Any) => n.text)).toEqual(['Watched']);
    // A reviewer filter with no matches returns an empty tree.
    expect((await call('get-tree', { reviewer: { kind: 'agent', id: 'agent_ws' } })).tree).toEqual([]);
  });
});
