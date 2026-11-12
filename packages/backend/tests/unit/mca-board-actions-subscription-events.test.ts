/**
 * Integration test — MCA board actions emit board subscription events
 * (fb_d211b16343bd3034).
 *
 * This is the regression test for the reported bug: agent board tools go
 * through the MCA inline query paths (mca-connection-manager.queries-board-*),
 * which implemented the mutations but NEVER called notifySubscribers — so
 * Alice's subscription (eventTypes + taskIds filter) received zero wakes for
 * Nira's progress notes, while task_moved from complete_my_task (which routes
 * to the domain handler) did arrive.
 *
 * Chain asserted here (the full event→wake path up to the injector, which is
 * where event-handler takes over):
 *
 *   handleBoardRunnerAction('add_my_progress_note')
 *     → boardService.addProgressNote (mocked)
 *     → emitTaskProgressNote → BoardSubscriptionService.notifySubscribers (REAL)
 *     → _dispatch → _passesFilter (REAL, Alice's exact filter)
 *     → eventInjector (captured ScheduledEvent with wakeUpAgent: true)
 *
 * Also covers the second anomaly: a second subscribe() on the same
 * board+channel updates the existing subscription in place (same
 * subscriptionId, original createdAt) — now surfaced via
 * subscribeWithStatus / the handler's `created` flag.
 */

import { describe, expect, it } from 'bun:test';
import { handleBoardRunnerAction } from '../../src/services/mca-connection-manager.queries-board-runner';
import { handleBoardWriteAction } from '../../src/services/mca-connection-manager.queries-board-write';
import { handleBoardReadAction } from '../../src/services/mca-connection-manager.queries-board-read';
import { BoardSubscriptionService } from '../../src/services/board-subscription-service';
import type { QueryHandlerContext, ActiveConnection } from '../../src/services/mca-connection-manager.types';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BOARD_ID = 'board_1';
const TASK_ID = 'task_1';

const board = {
  boardId: BOARD_ID,
  projectId: 'proj_1',
  columns: [
    { columnId: 'col_todo', name: 'To Do', slug: 'todo' },
    { columnId: 'col_inprogress', name: 'In Progress', slug: 'in_progress' },
    { columnId: 'col_review', name: 'Review', slug: 'review' },
    { columnId: 'col_done', name: 'Done', slug: 'done' },
  ],
};

const task = {
  taskId: TASK_ID,
  title: 'Fix login bug',
  boardId: BOARD_ID,
  assignedAgentId: 'agent_nira',
  tags: ['bug'],
  columnId: 'col_inprogress',
};

const connection = {
  appId: 'app_test',
  mcaId: 'mca.teros.board-runner',
  ownerId: 'user_pablo',
  connectedAt: Date.now(),
  status: 'healthy' as const,
} as unknown as ActiveConnection;

/** The exact filter from the bug report (Alice's subscription). */
const aliceFilter = {
  eventTypes: ['board.task_progress_note', 'board.task_moved', 'board.task_updated'] as any,
  taskIds: [TASK_ID],
};

/**
 * Build a QueryHandlerContext with a REAL BoardSubscriptionService over a
 * mock db holding ONE subscription (Alice's channel + the bug's filter).
 * boardService is a mock that returns the fixture task/board.
 */
function makeCtx(overrides: { filter?: any; channelId?: string } = {}) {
  const channelId = overrides.channelId ?? 'ch_alice';
  const filter = overrides.filter ?? aliceFilter;
  const subs = [{ channelId, boardId: BOARD_ID, filter, agentId: 'agent_alice' }];

  const injected: any[] = [];
  const db = {
    collection: () => ({
      find: (q: any) => ({
        toArray: async () => subs.filter((s) => s.boardId === q.boardId),
      }),
    }),
  } as any;
  const bss = new BoardSubscriptionService(db);
  bss.setEventInjector(async (e: any) => {
    injected.push(e);
    return { success: true };
  });

  const boardService = {
    getTask: async (id: string) => (id === TASK_ID ? { ...task } : null),
    getBoard: async (id: string) => (id === BOARD_ID ? board : null),
    getProject: async () => ({ projectId: 'proj_1', workspaceId: 'work_1' }),
    addProgressNote: async (id: string, text: string, actor: string) => ({
      ...task,
      progressNotes: [{ text, createdBy: actor }],
    }),
    moveTask: async () => ({ ...task, columnId: 'col_review' }),
    assignTask: async () => ({ ...task }),
    updateTask: async () => ({ ...task }),
  };

  const ctx = {
    db,
    boardService: boardService as any,
    boardSubscriptionService: bss,
    // reviewClaimService undefined → guardReviewClaim is a no-op (single-session safe)
    pubSubService: { broadcastToTopic: () => {} },
    send: () => true,
    emit: () => true,
    resolveEffectiveAgentId: async () => 'agent_nira',
    dispatchToRouter: async () => {
      throw new Error('unexpected dispatchToRouter in this test');
    },
  } as unknown as QueryHandlerContext;

  return { ctx, injected, bss };
}

/** Wait for the fire-and-forget notifySubscribers → _dispatch to settle. */
const settle = () => new Promise((r) => setTimeout(r, 20));

// ─── THE bug case: add_my_progress_note (runner path) ───────────────────────

describe('MCA add_my_progress_note → board subscription event → wake', () => {
  it('emits board.task_progress_note that passes the taskIds+eventTypes filter and wakes the subscriber', async () => {
    const { ctx, injected } = makeCtx();

    const result = await handleBoardRunnerAction(
      ctx,
      'add_my_progress_note',
      { taskId: TASK_ID, agentId: 'agent_nira', text: 'avance 50%' },
      'user_pablo',
      'agent_nira',
      connection,
      'app_test',
    );

    // Mutation succeeded and returned the task
    expect((result as any).task.taskId).toBe(TASK_ID);
    await settle();

    // The event reached Alice's channel with wake requested
    expect(injected).toHaveLength(1);
    const evt = injected[0];
    expect(evt.channelId).toBe('ch_alice');
    expect(evt.wakeUpAgent).toBe(true);
    expect(evt.eventType).toBe('task_update');
    expect(evt.metadata.source).toBe('board_subscription');
    expect(evt.metadata.boardEventType).toBe('board.task_progress_note');
    expect(evt.metadata.boardId).toBe(BOARD_ID);
    expect(evt.metadata.taskId).toBe(TASK_ID);
    expect(evt.metadata.noteText).toBe('avance 50%');
    expect(evt.metadata.actorAgentId).toBe('agent_nira'); // self-wake guard input
    expect(evt.message).toContain('avance 50%');
  });

  it('a progress note for a DIFFERENT task does not reach the taskIds-filtered subscription', async () => {
    const { ctx, injected } = makeCtx();

    // The mock boardService only knows task_1; simulate another task by
    // pointing the filter at a task the note is NOT for.
    const { ctx: ctxOther, injected: injectedOther } = makeCtx({
      filter: { eventTypes: ['board.task_progress_note'], taskIds: ['task_OTHER'] },
    });

    await handleBoardRunnerAction(
      ctx,
      'add_my_progress_note',
      { taskId: TASK_ID, agentId: 'agent_nira', text: 'avance 50%' },
      'user_pablo',
      'agent_nira',
      connection,
      'app_test',
    );
    await settle();
    // Alice (task_1 filter) receives it…
    expect(injected).toHaveLength(1);

    // …but a subscription filtered to another task receives nothing
    await handleBoardRunnerAction(
      ctxOther,
      'add_my_progress_note',
      { taskId: TASK_ID, agentId: 'agent_nira', text: 'avance 50%' },
      'user_pablo',
      'agent_nira',
      connection,
      'app_test',
    );
    await settle();
    expect(injectedOther).toHaveLength(0);
  });

  it('board-wide subscription (no taskIds) also receives the progress note', async () => {
    const { ctx, injected } = makeCtx({ filter: {} });
    await handleBoardRunnerAction(
      ctx,
      'add_my_progress_note',
      { taskId: TASK_ID, agentId: 'agent_nira', text: 'avance' },
      'user_pablo',
      'agent_nira',
      connection,
      'app_test',
    );
    await settle();
    expect(injected).toHaveLength(1);
    expect(injected[0].metadata.boardEventType).toBe('board.task_progress_note');
  });
});

// ─── Other MCA actions now emit too ─────────────────────────────────────────

describe('other MCA board actions emit subscription events', () => {
  it('add_progress_note (manager path) emits board.task_progress_note', async () => {
    const { ctx, injected } = makeCtx();
    await handleBoardWriteAction(
      ctx,
      'add_progress_note',
      { taskId: TASK_ID, text: 'nota del manager' },
      'user_pablo',
      'agent_alice',
      connection,
    );
    await settle();
    expect(injected).toHaveLength(1);
    expect(injected[0].metadata.boardEventType).toBe('board.task_progress_note');
    expect(injected[0].metadata.noteText).toBe('nota del manager');
  });

  it('move_task (manager path) emits board.task_moved with from/to columns', async () => {
    const { ctx, injected } = makeCtx();
    await handleBoardReadAction(
      ctx,
      'move_task',
      { taskId: TASK_ID, columnId: 'col_review' },
      'user_pablo',
      'agent_alice',
      connection,
    );
    await settle();
    expect(injected).toHaveLength(1);
    expect(injected[0].metadata.boardEventType).toBe('board.task_moved');
    expect(injected[0].metadata.fromColumnId).toBe('col_inprogress');
    expect(injected[0].metadata.fromColumnName).toBe('In Progress');
    expect(injected[0].metadata.toColumnId).toBe('col_review');
    expect(injected[0].metadata.toColumnName).toBe('Review');
    expect(injected[0].message).toContain('from "In Progress" to "Review"');
  });

  it('move_my_task (runner path) emits board.task_moved', async () => {
    const { ctx, injected } = makeCtx();
    await handleBoardRunnerAction(
      ctx,
      'move_my_task',
      { taskId: TASK_ID, agentId: 'agent_nira', columnId: 'col_done' },
      'user_pablo',
      'agent_nira',
      connection,
      'app_test',
    );
    await settle();
    expect(injected).toHaveLength(1);
    expect(injected[0].metadata.boardEventType).toBe('board.task_moved');
    expect(injected[0].metadata.actorAgentId).toBe('agent_nira');
  });

  it('assign_task emits board.task_assigned', async () => {
    const { ctx, injected } = makeCtx({ filter: { eventTypes: ['board.task_assigned'] } });
    await handleBoardReadAction(
      ctx,
      'assign_task',
      { taskId: TASK_ID, agentId: 'agent_nira' },
      'user_pablo',
      'agent_alice',
      connection,
    );
    await settle();
    expect(injected).toHaveLength(1);
    expect(injected[0].metadata.boardEventType).toBe('board.task_assigned');
  });

  it('update_task emits board.task_updated', async () => {
    const { ctx, injected } = makeCtx();
    await handleBoardReadAction(
      ctx,
      'update_task',
      { taskId: TASK_ID, title: 'Nuevo título' },
      'user_pablo',
      'agent_alice',
      connection,
    );
    await settle();
    expect(injected).toHaveLength(1);
    expect(injected[0].metadata.boardEventType).toBe('board.task_updated');
  });

  it('create_task emits board.task_created', async () => {
    const { ctx, injected } = makeCtx({ filter: { eventTypes: ['board.task_created'] } });
    // create_task resolves the project first — extend the mock for this action
    (ctx.boardService as any).getProject = async () => ({ projectId: 'proj_1', boardId: BOARD_ID, workspaceId: 'work_1' });
    (ctx.boardService as any).createTask = async () => ({
      ...task,
      taskId: 'task_new',
      title: 'Nueva',
      columnId: 'col_todo',
    });
    await handleBoardReadAction(
      ctx,
      'create_task',
      { projectId: 'proj_1', title: 'Nueva', instructions: 'haz esto' },
      'user_pablo',
      'agent_alice',
      connection,
    );
    await settle();
    expect(injected).toHaveLength(1);
    expect(injected[0].metadata.boardEventType).toBe('board.task_created');
    expect(injected[0].metadata.taskId).toBe('task_new');
    expect(injected[0].message).toContain('Nueva');
  });

  it('archive_task emits board.task_archived', async () => {
    const { ctx, injected } = makeCtx({ filter: { eventTypes: ['board.task_archived'] } });
    (ctx.boardService as any).archiveTask = async () => ({ ...task, archived: true });
    await handleBoardWriteAction(
      ctx,
      'archive_task',
      { taskId: TASK_ID, archived: true },
      'user_pablo',
      'agent_alice',
      connection,
    );
    await settle();
    expect(injected).toHaveLength(1);
    expect(injected[0].metadata.boardEventType).toBe('board.task_archived');
    expect(injected[0].metadata.archived).toBe(true);
  });

  it('add_dependency / remove_dependency emit dependency events', async () => {
    const { ctx, injected } = makeCtx({
      filter: { eventTypes: ['board.dependency_added', 'board.dependency_removed'] },
    });
    (ctx.boardService as any).addDependency = async () => ({ ...task });
    (ctx.boardService as any).removeDependency = async () => ({ ...task });
    await handleBoardRunnerAction(
      ctx,
      'add_dependency',
      { taskId: TASK_ID, dependsOnTaskId: 'task_2' },
      'user_pablo',
      'agent_alice',
      connection,
      'app_test',
    );
    await handleBoardRunnerAction(
      ctx,
      'remove_dependency',
      { taskId: TASK_ID, dependsOnTaskId: 'task_2' },
      'user_pablo',
      'agent_alice',
      connection,
      'app_test',
    );
    await settle();
    expect(injected).toHaveLength(2);
    expect(injected[0].metadata.boardEventType).toBe('board.dependency_added');
    expect(injected[1].metadata.boardEventType).toBe('board.dependency_removed');
  });

  it('link_conversation emits board.task_updated', async () => {
    const { ctx, injected } = makeCtx();
    (ctx.boardService as any).linkConversation = async () => ({ ...task, channelId: 'ch_new' });
    await handleBoardWriteAction(
      ctx,
      'link_conversation',
      { taskId: TASK_ID, channelId: 'ch_new' },
      'user_pablo',
      'agent_alice',
      connection,
    );
    await settle();
    expect(injected).toHaveLength(1);
    expect(injected[0].metadata.boardEventType).toBe('board.task_updated');
  });
});

// ─── Second anomaly: subscribe upsert semantics ──────────────────────────────

describe('subscribeWithStatus — second subscribe updates in place (fb anomaly #2)', () => {
  function makeUpsertDb() {
    const store = new Map<string, any>();
    const col = {
      findOne: async (q: any) => store.get(`${q.boardId}|${q.channelId}`) ?? null,
      findOneAndUpdate: async (q: any, update: any) => {
        const key = `${q.boardId}|${q.channelId}`;
        const doc = store.get(key);
        const updated = { ...doc, ...update.$set };
        store.set(key, updated);
        return updated;
      },
      insertOne: async (doc: any) => {
        store.set(`${doc.boardId}|${doc.channelId}`, doc);
        return { acknowledged: true };
      },
      find: (q: any) => ({
        toArray: async () =>
          [...store.values()].filter((s) => s.boardId === q.boardId),
      }),
    };
    return { db: { collection: () => col } as any, store };
  }

  it('first call creates (created=true), second call replaces the filter in place (created=false, same subscriptionId)', async () => {
    const { db } = makeUpsertDb();
    const svc = new BoardSubscriptionService(db);

    const first = await svc.subscribeWithStatus('board_1', 'ch_alice', 'agent_alice', {
      eventTypes: ['board.task_progress_note'],
      taskIds: ['task_1'],
    });
    expect(first.created).toBe(true);
    expect(first.subscription.filter).toEqual({
      eventTypes: ['board.task_progress_note'],
      taskIds: ['task_1'],
    });

    const second = await svc.subscribeWithStatus('board_1', 'ch_alice', 'agent_alice', {
      eventTypes: ['board.task_moved'],
    });
    // Same subscription (upsert in place), filter REPLACED, not merged
    expect(second.created).toBe(false);
    expect(second.subscription.subscriptionId).toBe(first.subscription.subscriptionId);
    expect(second.subscription.filter).toEqual({ eventTypes: ['board.task_moved'] });
    expect(second.subscription.createdAt).toEqual(first.subscription.createdAt);
  });
});
