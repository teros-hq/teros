/**
 * Tests: thin client — forwarding contract.
 *
 * The MCA holds no datastore; every tool and UI resource forwards to a
 * backend action. These tests pin the contract the backend relies on:
 * - each tool calls `todo/<tool>` with its args, never sending `workspaceId`
 * - the backend answer is returned verbatim in the structured envelope
 * - dispatcher errors `{ error, code, suggestion? }` are rebuilt as the
 *   `[CODE] message suggestion` Error string the renderer/consumers parse
 * - an omitted `newParentId` stays omitted and an explicit `null` stays null
 * - events are emitted with the former payloads (best-effort)
 * - UI resources fetch through `todo/get-tree` / `todo/get-node`
 *
 * The DB semantics themselves (positions, cascade, reindex, search paths)
 * now live in packages/backend/src/mca-actions/todo.ts and are NOT covered
 * here (follow-up: port the former storage/tools tests to the backend).
 */

import { describe, expect, it } from 'bun:test';
import { TOOLS } from '../src/tools';
import { TODO_EVENTS } from '../src/events';
import { treeResource } from '../src/ui/tree';
import { detailResource } from '../src/ui/detail';
import { formResource } from '../src/ui/form';
import { backendError, getResult, makeMockContext } from './helpers/mock-context';

const NODE = {
  nodeId: 'tn_abc',
  parentId: 'tn_root',
  text: 'Buy milk',
  description: '',
  instructions: '',
  completed: false,
  collapsed: false,
  position: 0,
  log: [],
  createdAt: 1,
  updatedAt: 2,
};

async function run(tool: string, args: Record<string, unknown>, ctx: ReturnType<typeof makeMockContext>) {
  return TOOLS[tool].handler(args, ctx);
}

describe('thin client — tool registry', () => {
  // NOTE: the reserved subscription tools (-subscribe/-unsubscribe/-list-subscriptions)
  // are registered directly on the MCP server by the SDK's registerSubscriptionTools
  // helper — they are NOT part of the thin-client TOOLS map and are asserted via the
  // generated tools.json + backend subscriptions.test.ts instead.
  it('exposes the 11 former tools plus the state/group/progress/IO, autoplay and legacy subscription tools', () => {
    expect(Object.keys(TOOLS).sort()).toEqual(
      [
        '-health-check',
        'add-dependency',
        'add-log-entry',
        'add-node',
        'archive-finished',
        'delete-node',
        'get-node',
        'get-tree',
        'move-node',
        'list-todo-subscriptions',
        'open-runner-terminal',
        'remove-dependency',
        'search-nodes',
        'set-archived',
        'set-reviewer',
        'plan-node',
        'get-day',
        'assign-node',
        'get-autoplay',
        'set-agent-slots',
        'set-agent-play',
        'set-agent-scope',
        'set-global-play',
        'stop-autoplay',
        'subscribe-to-todo',
        'unsubscribe-from-todo',
        'remove-agent',
        'start-node',
        'share-io',
        'get-io-share',
        'unshare-io',
        'set-input',
        'set-kind',
        'set-output',
        'set-progress',
        'set-state',
        'toggle-collapse',
        'toggle-complete',
        'toggle-instruction-item',
        'update-node',
      ].sort(),
    );
  });

  it('declares the 8 events', () => {
    expect(TODO_EVENTS.map((e) => e.name as string).sort()).toEqual(
      [
        'node.added',
        'node.completed',
        'node.deleted',
        'node.moved',
        'node.output',
        'node.progress',
        'node.state',
        'node.updated',
      ].sort(),
    );
  });

  it('marks every new write tool as a safe write and describes add-node kind/state', () => {
    for (const tool of ['set-state', 'set-kind', 'set-progress', 'set-input', 'set-output', 'toggle-instruction-item', 'plan-node', 'assign-node']) {
      expect(TOOLS[tool].annotations).toMatchObject({ readOnlyHint: false, safeWriteHint: true });
    }
    const props = (TOOLS['add-node'].parameters as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.kind.enum).toEqual(['task', 'group']);
    expect(props.state.enum).not.toContain('blocked');
    const stateProps = (TOOLS['set-state'].parameters as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(stateProps.state.enum).toEqual(['planning', 'pending', 'working', 'blocked', 'review', 'done', 'cancelled']);
  });
});

describe('thin client — state, group, progress and IO tools', () => {
  const forwarded: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['set-state', { nodeId: 'tn_abc', state: 'blocked', reason: 'tax ID' }, { node: { ...NODE, state: 'blocked', blockedReason: 'tax ID' }, transition: { from: 'working', to: 'blocked' } }],
    ['set-kind', { nodeId: 'tn_abc', kind: 'group' }, { node: { ...NODE, kind: 'group', state: null } }],
    ['set-progress', { nodeId: 'tn_abc', progress: 40 }, { node: { ...NODE, reportedProgress: 40 } }],
    ['set-input', { nodeId: 'tn_abc', input: { format: 'markdown', markdown: 'ctx' } }, { node: { ...NODE, input: { format: 'markdown', markdown: 'ctx' } } }],
    [
      'set-output',
      { nodeId: 'tn_abc', output: { format: 'file', name: 'a.pdf', mime: 'application/pdf', data: 'aGk=' } },
      { node: { ...NODE, output: { format: 'file', objectId: 'obj_1', url: 'u', name: 'a.pdf', mime: 'application/pdf', size: 2 } } },
    ],
    ['toggle-instruction-item', { nodeId: 'tn_abc', index: 0 }, { node: { nodeId: 'tn_abc', instructions: '- [x] a' }, item: { index: 0, checked: true, text: 'a' } }],
    ['plan-node', { nodeId: 'tn_abc', day: '2026-10-24', index: 0, time: '09:00' }, { node: { ...NODE, plannedFor: '2026-10-24', dayOrder: 0, plannedTime: '09:00' }, day: '2026-10-24', previousDay: null }],
    ['get-day', { day: '2026-10-24', today: '2026-10-24' }, { day: '2026-10-24', today: '2026-10-24', tasks: [], overdue: [], unplanned: [] }],
    ['assign-node', { nodeId: 'tn_abc', assignee: { kind: 'agent', id: 'agent_1' } }, { node: { ...NODE, assignee: { kind: 'agent', id: 'agent_1' }, assignedAt: 1 } }],
  ];

  for (const [tool, args, answer] of forwarded) {
    it(`${tool} forwards to todo/${tool} verbatim`, async () => {
      const ctx = makeMockContext({ respond: { [`todo/${tool}`]: () => answer } });
      const result = await run(tool, args, ctx);
      // Every tool that can log carries the caller (TODOLG-REQ-1); set-state also
      // posts a reply as them (TODOAP-REQ-10). get-day writes nothing.
      const body = tool === 'get-day' ? args : { ...args, callerUserId: 'test-user' };
      expect(ctx._calls).toEqual([{ actionPath: `todo/${tool}`, body }]);
      expect(getResult(result) as unknown).toEqual(answer);
    });
  }

  it('set-state emits node.state on a real transition only', async () => {
    const ctx = makeMockContext({ respond: { 'todo/set-state': () => forwarded[0][2] } });
    await run('set-state', forwarded[0][1], ctx);
    expect(ctx._events).toEqual([
      { name: 'node.state', payload: { nodeId: 'tn_abc', from: 'working', to: 'blocked', blockedReason: 'tax ID' } },
    ]);
    const noop = makeMockContext({
      respond: { 'todo/set-state': () => ({ node: NODE, transition: { from: 'pending', to: 'pending' } }) },
    });
    await run('set-state', { nodeId: 'tn_abc', state: 'pending' }, noop);
    expect(noop._events).toEqual([]);
  });

  it('set-progress emits node.progress and set-output emits node.output', async () => {
    const ctx = makeMockContext({
      respond: { 'todo/set-progress': () => forwarded[2][2], 'todo/set-output': () => forwarded[4][2] },
    });
    await run('set-progress', forwarded[2][1], ctx);
    await run('set-output', forwarded[4][1], ctx);
    expect(ctx._events).toEqual([
      { name: 'node.progress', payload: { nodeId: 'tn_abc', progress: 40 } },
      { name: 'node.output', payload: { nodeId: 'tn_abc', format: 'file' } },
    ]);
  });

  it('set-kind, set-input and toggle-instruction-item emit node.updated with the changed field', async () => {
    const ctx = makeMockContext({
      respond: {
        'todo/set-kind': () => forwarded[1][2],
        'todo/set-input': () => forwarded[3][2],
        'todo/toggle-instruction-item': () => forwarded[5][2],
      },
    });
    await run('set-kind', forwarded[1][1], ctx);
    await run('set-input', forwarded[3][1], ctx);
    await run('toggle-instruction-item', forwarded[5][1], ctx);
    expect(ctx._events.map((e) => (e.payload as { fields: string[] }).fields)).toEqual([['kind'], ['input'], ['instructions']]);
  });

  it('rebuilds the new domain errors', async () => {
    const ctx = makeMockContext({
      respond: {
        'todo/set-state': () =>
          backendError(400, {
            error: 'Cannot move a task from "planning" to "done".',
            code: 'INVALID_TRANSITION',
            suggestion: 'Allowed from "planning": pending.',
          }),
      },
    });
    await expect(run('set-state', { nodeId: 'tn_abc', state: 'done' }, ctx)).rejects.toThrow(
      '[INVALID_TRANSITION] Cannot move a task from "planning" to "done". Allowed from "planning": pending.',
    );
    expect(ctx._events).toEqual([]);
  });
});

describe('thin client — forwarding', () => {
  const simple: Array<[string, Record<string, unknown>]> = [
    ['get-node', { nodeId: 'tn_abc' }],
    ['get-tree', { depth: 0 }],
    ['toggle-collapse', { nodeId: 'tn_abc' }],
    ['search-nodes', { query: 'milk' }],
  ];

  for (const [tool, args] of simple) {
    it(`${tool} forwards to todo/${tool} and returns the answer in the envelope`, async () => {
      const answer = { marker: tool };
      const ctx = makeMockContext({ respond: { [`todo/${tool}`]: () => answer } });
      const result = await run(tool, args, ctx);
      expect(ctx._calls).toEqual([{ actionPath: `todo/${tool}`, body: args }]);
      expect(getResult(result)).toEqual(answer);
      expect((result as { content: Array<{ text: string }> }).content[0].text).toBe(JSON.stringify(answer));
    });
  }

  it('never sends workspaceId to the backend', async () => {
    const ctx = makeMockContext({ respond: { 'todo/get-tree': () => ({ tree: [] }) } });
    await run('get-tree', { workspaceId: 'ws_forged', depth: -1 }, ctx);
    expect(ctx._calls[0].body).toEqual({ depth: -1 });
  });

  it('get-tree tolerates undefined args', async () => {
    const ctx = makeMockContext({ respond: { 'todo/get-tree': () => ({ tree: [] }) } });
    await TOOLS['get-tree'].handler(undefined as unknown as Record<string, unknown>, ctx);
    expect(ctx._calls[0].body).toEqual({});
  });

  it('fails with NO_BACKEND_CONTEXT when the context has no backend client', async () => {
    const ctx = makeMockContext({ noBackend: true });
    await expect(run('get-node', { nodeId: 'x' }, ctx)).rejects.toThrow(/^\[NO_BACKEND_CONTEXT\]/);
  });
});

describe('thin client — error rebuilding', () => {
  it('rebuilds [CODE] message suggestion from the dispatcher body', async () => {
    const ctx = makeMockContext({
      respond: {
        'todo/add-node': () =>
          backendError(404, {
            error: 'Parent node not found: tn_x',
            code: 'NOT_FOUND',
            suggestion: 'Get valid IDs with get-tree.',
          }),
      },
    });
    await expect(run('add-node', { text: 'a', parentId: 'tn_x' }, ctx)).rejects.toThrow(
      '[NOT_FOUND] Parent node not found: tn_x Get valid IDs with get-tree.',
    );
  });

  it('omits the suggestion when the body has none', async () => {
    const ctx = makeMockContext({
      respond: { 'todo/move-node': () => backendError(400, { error: 'Cannot move a node into itself.', code: 'CIRCULAR_MOVE' }) },
    });
    ctx._calls.length = 0;
    const ctxWithNode = makeMockContext({
      respond: {
        'todo/get-node': () => ({ node: NODE }),
        'todo/move-node': () => backendError(400, { error: 'Cannot move a node into itself.', code: 'CIRCULAR_MOVE' }),
      },
    });
    await expect(run('move-node', { nodeId: 'tn_abc', newParentId: 'tn_abc' }, ctxWithNode)).rejects.toThrow(
      '[CIRCULAR_MOVE] Cannot move a node into itself.',
    );
  });

  it('falls back to BACKEND_ERROR when the body carries no code', async () => {
    const ctx = makeMockContext({
      respond: { 'todo/get-node': () => backendError(403, { error: "Capability 'todo' is not available to mca.x" }) },
    });
    await expect(run('get-node', { nodeId: 'x' }, ctx)).rejects.toThrow("[BACKEND_ERROR] Capability 'todo' is not available to mca.x");
  });

  it('rethrows non-action failures untouched', async () => {
    const ctx = makeMockContext({ respond: { 'todo/get-node': () => new Error('Backend request timeout after 30000ms') } });
    await expect(run('get-node', { nodeId: 'x' }, ctx)).rejects.toThrow('Backend request timeout after 30000ms');
  });
});

describe('thin client — move-node parent semantics', () => {
  it('keeps newParentId OMITTED when the caller omits it', async () => {
    const ctx = makeMockContext({
      respond: { 'todo/get-node': () => ({ node: NODE }), 'todo/move-node': () => ({ node: { ...NODE, position: 2 } }) },
    });
    await run('move-node', { nodeId: 'tn_abc', newPosition: 2 }, ctx);
    const move = ctx._calls.find((c) => c.actionPath === 'todo/move-node')!;
    expect('newParentId' in move.body).toBe(false);
    expect(move.body).toEqual({ nodeId: 'tn_abc', newPosition: 2, callerUserId: 'test-user' });
  });

  it('keeps an explicit null newParentId (move to root)', async () => {
    const ctx = makeMockContext({
      respond: { 'todo/get-node': () => ({ node: NODE }), 'todo/move-node': () => ({ node: { ...NODE, parentId: null } }) },
    });
    await run('move-node', { nodeId: 'tn_abc', newParentId: null }, ctx);
    const move = ctx._calls.find((c) => c.actionPath === 'todo/move-node')!;
    expect(move.body).toEqual({ nodeId: 'tn_abc', newParentId: null, callerUserId: 'test-user' });
  });

  it('emits node.moved with the previous parent read before the move', async () => {
    const ctx = makeMockContext({
      respond: {
        'todo/get-node': () => ({ node: NODE }),
        'todo/move-node': () => ({ node: { ...NODE, parentId: 'tn_other', position: 1 } }),
      },
    });
    await run('move-node', { nodeId: 'tn_abc', newParentId: 'tn_other', newPosition: 1 }, ctx);
    expect(ctx._calls.map((c) => c.actionPath)).toEqual(['todo/get-node', 'todo/move-node']);
    expect(ctx._events).toEqual([
      { name: 'node.moved', payload: { nodeId: 'tn_abc', newParentId: 'tn_other', oldParentId: 'tn_root', position: 1 } },
    ]);
  });
});

describe('thin client — events', () => {
  it('add-node emits node.added', async () => {
    const ctx = makeMockContext({ respond: { 'todo/add-node': () => ({ node: NODE, parentText: 'Root' }) } });
    await run('add-node', { text: 'Buy milk', parentId: 'tn_root' }, ctx);
    expect(ctx._events).toEqual([{ name: 'node.added', payload: { nodeId: 'tn_abc', parentId: 'tn_root', text: 'Buy milk' } }]);
  });

  it('update-node emits node.updated with the provided fields', async () => {
    const ctx = makeMockContext({ respond: { 'todo/update-node': () => ({ node: { ...NODE, text: 'New' } }) } });
    await run('update-node', { nodeId: 'tn_abc', text: 'New', instructions: '' }, ctx);
    expect(ctx._events).toEqual([{ name: 'node.updated', payload: { nodeId: 'tn_abc', text: 'New', fields: ['text', 'instructions'] } }]);
  });

  it('toggle-complete emits node.completed', async () => {
    const ctx = makeMockContext({ respond: { 'todo/toggle-complete': () => ({ node: { ...NODE, completed: true } }) } });
    await run('toggle-complete', { nodeId: 'tn_abc' }, ctx);
    expect(ctx._events).toEqual([{ name: 'node.completed', payload: { nodeId: 'tn_abc', completed: true } }]);
  });

  it('delete-node emits node.deleted and keeps the top-level nodeId', async () => {
    const ctx = makeMockContext({
      respond: { 'todo/delete-node': () => ({ deleted: true, nodeId: 'tn_abc', node: { text: 'Buy milk', description: '', completed: false } }) },
    });
    const result = getResult(await run('delete-node', { nodeId: 'tn_abc' }, ctx));
    expect(result.nodeId).toBe('tn_abc');
    expect(result.deleted).toBe(true);
    expect(ctx._events).toEqual([{ name: 'node.deleted', payload: { nodeId: 'tn_abc', text: 'Buy milk' } }]);
  });

  it('does not emit (and does not fail) when the action fails', async () => {
    const ctx = makeMockContext({ respond: { 'todo/add-node': () => backendError(400, { error: 'bad', code: 'INVALID_INPUT' }) } });
    await expect(run('add-node', { text: '' }, ctx)).rejects.toThrow('[INVALID_INPUT] bad');
    expect(ctx._events).toEqual([]);
  });
});

describe('thin client — health check', () => {
  it('is ready when todo/ping answers', async () => {
    const ctx = makeMockContext({ respond: { 'todo/ping': () => ({ ok: true }) } });
    const result = (await run('-health-check', {}, ctx)) as { status: string; version?: string; issues?: unknown[] };
    expect(ctx._calls).toEqual([{ actionPath: 'todo/ping', body: {} }]);
    expect(result.status).toBe('ready');
    expect(result.version).toBe('2.0.0');
  });

  it('reports DEPENDENCY_UNAVAILABLE when the backend is unreachable', async () => {
    const ctx = makeMockContext({ respond: { 'todo/ping': () => new Error('ECONNREFUSED') } });
    const result = (await run('-health-check', {}, ctx)) as { status: string; issues: Array<{ code: string }> };
    expect(result.status).not.toBe('ready');
    expect(result.issues[0].code).toBe('DEPENDENCY_UNAVAILABLE');
  });
});

describe('thin client — UI resources', () => {
  it('tree fetches todo/get-tree and maps nodes', async () => {
    const ctx = makeMockContext({
      respond: {
        'todo/get-tree': () => ({
          tree: [
            {
              nodeId: 'tn_a',
              parentId: null,
              text: 'A',
              description: '',
              completed: false,
              collapsed: true,
              position: 0,
              childCount: 2,
              completedChildren: 1,
            },
          ],
        }),
      },
    });
    const data = (await treeResource.handler({ depth: 0 }, ctx)) as { type: string; nodes: Array<Record<string, unknown>> };
    expect(ctx._calls).toEqual([{ actionPath: 'todo/get-tree', body: { depth: 0 } }]);
    expect(data.type).toBe('tree');
    expect(data.nodes[0]).toMatchObject({ id: 'tn_a', label: 'A', badge: '1/2 done', expanded: false, icon: 'folder' });
  });

  it('tree passes nodeId only when provided', async () => {
    const ctx = makeMockContext({ respond: { 'todo/get-tree': () => ({ tree: [] }) } });
    await treeResource.handler({ nodeId: 'tn_a' }, ctx);
    expect(ctx._calls[0].body).toEqual({ nodeId: 'tn_a', depth: -1 });
  });

  it('detail fetches todo/get-node', async () => {
    const ctx = makeMockContext({ respond: { 'todo/get-node': () => ({ node: { ...NODE, log: [{ timestamp: 5, text: 'hi' }] } }) } });
    const data = (await detailResource.handler({ nodeId: 'tn_abc' }, ctx)) as { type: string; title: string; sections: unknown[] };
    expect(ctx._calls).toEqual([{ actionPath: 'todo/get-node', body: { nodeId: 'tn_abc' } }]);
    expect(data.type).toBe('detail');
    expect(data.title).toBe('Buy milk');
    expect(data.sections).toHaveLength(2);
  });

  it('detail requires nodeId', async () => {
    const ctx = makeMockContext();
    await expect(detailResource.handler({}, ctx)).rejects.toThrow('[INVALID_INPUT] Parameter "nodeId" is required.');
    expect(ctx._calls).toEqual([]);
  });

  it('detail surfaces NOT_FOUND from the action', async () => {
    const ctx = makeMockContext({ respond: { 'todo/get-node': () => backendError(404, { error: 'Node "tn_x" not found.', code: 'NOT_FOUND' }) } });
    await expect(detailResource.handler({ nodeId: 'tn_x' }, ctx)).rejects.toThrow('[NOT_FOUND] Node "tn_x" not found.');
  });

  it('form (edit) fetches todo/get-node; form (add) touches no action', async () => {
    const ctx = makeMockContext({ respond: { 'todo/get-node': () => ({ node: NODE }) } });
    const edit = (await formResource.handler({ nodeId: 'tn_abc' }, ctx)) as { submitTool: string };
    expect(edit.submitTool).toBe('update-node');
    expect(ctx._calls).toEqual([{ actionPath: 'todo/get-node', body: { nodeId: 'tn_abc' } }]);

    const ctx2 = makeMockContext();
    const add = (await formResource.handler({ parentId: 'tn_root' }, ctx2)) as { submitTool: string; fields: Array<{ name: string }> };
    expect(add.submitTool).toBe('add-node');
    expect(add.fields[0].name).toBe('parentId');
    expect(ctx2._calls).toEqual([]);
  });
});

describe('thin client — autoplay tools (TODOAP)', () => {
  const RUNNER = { agentId: 'agent_1', name: 'Atlas', avatarUrl: null, slots: 2, playEnabled: true, activeSlots: 0 };
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['get-autoplay', {}, { runners: [RUNNER] }],
    ['set-agent-slots', { agentId: 'agent_1', slots: 2 }, { runner: RUNNER }],
    ['set-agent-play', { agentId: 'agent_1', enabled: true }, { runner: RUNNER }],
    ['remove-agent', { agentId: 'agent_1' }, { removed: true, agentId: 'agent_1' }],
    ['start-node', { nodeId: 'tn_abc' }, { node: { ...NODE, state: 'working', channelId: 'ch_1' }, channelId: 'ch_1' }],
  ];

  for (const [tool, args, answer] of cases) {
    it(`[TODOAP-AC-2] ${tool} forwards to todo/${tool} with the execution user as callerUserId`, async () => {
      const ctx = makeMockContext({ respond: { [`todo/${tool}`]: () => answer } });
      // A callerUserId in the args is never trusted: the execution context wins.
      const result = await run(tool, { ...args, callerUserId: 'someone-else' }, ctx);
      expect(ctx._calls).toEqual([{ actionPath: `todo/${tool}`, body: { ...args, callerUserId: 'test-user' } }]);
      expect(getResult(result) as unknown).toEqual(answer);
    });
  }

  it('marks the runner and start tools as safe writes and get-autoplay as read-only', () => {
    for (const tool of ['set-agent-slots', 'set-agent-play', 'remove-agent', 'start-node']) {
      expect(TOOLS[tool].annotations).toMatchObject({ readOnlyHint: false, safeWriteHint: true });
    }
    expect(TOOLS['get-autoplay'].annotations).toMatchObject({ readOnlyHint: true });
  });

  it('[TODOAP-AC-16] add-node and update-node take the expectedOutput definition; set-state takes reply', () => {
    type Schema = { type?: unknown; enum?: unknown[]; required?: string[]; properties?: Record<string, Schema> };
    for (const tool of ['add-node', 'update-node']) {
      const props = (TOOLS[tool].parameters as Schema).properties!;
      expect(props.outputFormat).toBeUndefined();
      const def = props.expectedOutput;
      expect(def.type).toEqual(['object', 'null']);
      expect(def.required).toEqual(['format']);
      expect(def.properties!.format.enum).toEqual(['markdown', 'form', 'file']);
      expect(def.properties!.fileType.enum).toEqual(['pdf', 'docx', 'xlsx', 'csv', 'png', 'jpg', 'json', 'md', 'txt', 'html', 'other']);
      expect(Object.keys(def.properties!)).toEqual(['format', 'description', 'fileType', 'fields']);
    }
    const st = (TOOLS['set-state'].parameters as Schema).properties!;
    expect(st.reply).toBeDefined();
  });
});

describe('thin client — io share tools (TODOOV)', () => {
  const SHARE = { shareId: 'a3f9c2d1e4b87f0c6d2e1a9b4c5f3e8d', publicUrl: 'https://x/share/a3f9c2d1e4b87f0c6d2e1a9b4c5f3e8d' };
  const cases: Array<[string, Record<string, unknown>, unknown]> = [
    ['share-io', { nodeId: 'tn_abc', io: 'output' }, SHARE],
    ['get-io-share', { nodeId: 'tn_abc', io: 'input' }, SHARE],
    ['unshare-io', { shareId: SHARE.shareId }, { ok: true }],
  ];

  for (const [tool, args, answer] of cases) {
    it(`[TODOOV-REQ-4] ${tool} forwards to todo/${tool} with the execution user as callerUserId`, async () => {
      const ctx = makeMockContext({ respond: { [`todo/${tool}`]: () => answer } });
      const result = await run(tool, { ...args, callerUserId: 'someone-else' }, ctx);
      expect(ctx._calls).toEqual([{ actionPath: `todo/${tool}`, body: { ...args, callerUserId: 'test-user' } }]);
      expect(getResult(result) as unknown).toEqual(answer);
    });
  }

  it('[TODOOV-REQ-4] share-io and unshare-io are writes without safeWriteHint (ask first), get-io-share is read-only; io is output | input', () => {
    for (const tool of ['share-io', 'unshare-io']) {
      expect(TOOLS[tool].annotations).toMatchObject({ readOnlyHint: false });
      expect(TOOLS[tool].annotations?.safeWriteHint).toBeUndefined();
    }
    expect(TOOLS['get-io-share'].annotations).toMatchObject({ readOnlyHint: true });
    for (const tool of ['share-io', 'get-io-share']) {
      const props = (TOOLS[tool].parameters as { properties: Record<string, { enum?: string[] }> }).properties;
      expect(props.io.enum).toEqual(['output', 'input']);
    }
  });
});

describe('thin client — the caller on every logging tool (TODOLG)', () => {
  // Each tool that can write a log entry, with minimal args and a backend answer it can digest.
  const logging: Array<[string, Record<string, unknown>]> = [
    ['add-log-entry', { nodeId: 'tn_abc', text: 'done' }],
    ['set-progress', { nodeId: 'tn_abc', progress: 40 }],
    ['set-output', { nodeId: 'tn_abc', output: null }],
    ['set-input', { nodeId: 'tn_abc', input: null }],
    ['assign-node', { nodeId: 'tn_abc', assignee: null }],
    ['plan-node', { nodeId: 'tn_abc', day: null }],
    ['set-kind', { nodeId: 'tn_abc', kind: 'group' }],
    ['toggle-complete', { nodeId: 'tn_abc' }],
    ['toggle-instruction-item', { nodeId: 'tn_abc', index: 0 }],
    ['update-node', { nodeId: 'tn_abc', text: 'x' }],
    ['add-node', { text: 'x' }],
    ['delete-node', { nodeId: 'tn_abc' }],
    ['move-node', { nodeId: 'tn_abc', newPosition: 0 }],
    ['set-state', { nodeId: 'tn_abc', state: 'working' }],
    ['start-node', { nodeId: 'tn_abc' }],
  ];
  const ANSWER = {
    node: NODE,
    item: { index: 0, checked: true, text: 'a' },
    transition: { from: 'pending', to: 'working' },
    deleted: ['tn_abc'],
    deletedCount: 1,
    day: null,
    previousDay: null,
  };

  for (const [tool, args] of logging) {
    it(`[TODOLG-AC-1] ${tool} sends the execution user as callerUserId, never the args' value`, async () => {
      const ctx = makeMockContext({ respond: { [`todo/${tool}`]: () => ANSWER, 'todo/get-node': () => ({ node: NODE }) } });
      await run(tool, { ...args, callerUserId: 'someone-else' }, ctx);
      const call = ctx._calls.find((c) => c.actionPath === `todo/${tool}`)!;
      expect(call.body).toEqual({ ...args, callerUserId: 'test-user' });
    });

    it(`[TODOLG-AC-1] ${tool} from an agent sends callerUserId, callerAgentId and callerChannelId from the execution context, never the args'`, async () => {
      const ctx = makeMockContext({ respond: { [`todo/${tool}`]: () => ANSWER, 'todo/get-node': () => ({ node: NODE }) } });
      Object.assign(ctx.execution, { agentId: 'agent_nira', channelId: 'ch_nira' });
      await run(tool, { ...args, callerUserId: 'x', callerAgentId: 'agent_fake', callerChannelId: 'ch_fake' }, ctx);
      const call = ctx._calls.find((c) => c.actionPath === `todo/${tool}`)!;
      expect(call.body).toEqual({ ...args, callerUserId: 'test-user', callerAgentId: 'agent_nira', callerChannelId: 'ch_nira' });
    });

    it(`[TODOLG-AC-1] ${tool} without an agent in the execution context sends only callerUserId`, async () => {
      const ctx = makeMockContext({ respond: { [`todo/${tool}`]: () => ANSWER, 'todo/get-node': () => ({ node: NODE }) } });
      Object.assign(ctx.execution, { channelId: 'ch_window' });
      await run(tool, { ...args, callerAgentId: 'agent_fake', callerChannelId: 'ch_fake' }, ctx);
      const call = ctx._calls.find((c) => c.actionPath === `todo/${tool}`)!;
      expect(call.body).toEqual({ ...args, callerUserId: 'test-user' });
    });
  }
});
