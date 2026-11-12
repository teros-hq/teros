/**
 * Single-flight review claim guard v2 — identity + adoption tests (R3).
 *
 * Covers incident #23 (2026-10-20): 7 parallel sessions of the same agent
 * all claimed the same review because (a) 6/7 did not pass reviewAction:true
 * and (b) the one that did resolve to the shared constant 'unknown-channel',
 * which made the claim's idempotent re-entry clause match for every session.
 *
 * These tests run against the v2 guard:
 *  - identity resolution order: params.callerChannelId → connection.currentChannelId
 *    → per-call generated anonymous-<uuid> (NEVER a shared constant).
 *  - adoption: guard applies when the task's current column slug is 'review'
 *    even without reviewAction:true; in_progress tasks are NOT guarded (AC-3).
 *  - fan-out integration: N parallel sessions of the same agent on a review
 *    task → exactly ONE write; the rest get { skipped: true }.
 */

import { describe, expect, it, mock } from 'bun:test';
import { handleBoardReadAction } from '../../src/services/mca-connection-manager.queries-board-read';
import { handleBoardWriteAction } from '../../src/services/mca-connection-manager.queries-board-write';
import { guardReviewClaim } from '../../src/services/mca-connection-manager.review-claim-guard';
import { ReviewClaimService } from '../../src/services/review-claim-service';
import type { Task } from '../../src/types/database';

const TASK_ID = 'task_review_v2';
const AGENT = 'agent_alice';
const CH_A = 'ch_session_A';
const CH_B = 'ch_session_B';

// ─── Faithful in-memory Mongo collection (same semantics as v1 tests) ──────
class FakeTasks {
  private doc: Task;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(doc: Task) { this.doc = doc; }
  private get(path: string): unknown {
    return path.split('.').reduce((o: any, k) => (o == null ? o : o[k]), this.doc as any);
  }
  private matches(filter: any): boolean {
    for (const [key, cond] of Object.entries(filter)) {
      if (key === '$or') {
        if (!(cond as any[]).some((s) => this.matches(s))) return false;
        continue;
      }
      const val = this.get(key);
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        const c = cond as Record<string, unknown>;
        if ('$exists' in c) { if ((val !== undefined) !== c.$exists) return false; }
        if ('$lte' in c) { if (!(typeof val === 'string' && val <= (c.$lte as string))) return false; }
        if (!('$exists' in c) && !('$lte' in c)) { if (val !== cond) return false; }
      } else if (val !== cond) return false;
    }
    return true;
  }
  private setPath(path: string, value: unknown): void {
    const keys = path.split('.');
    let o: any = this.doc;
    for (let i = 0; i < keys.length - 1; i++) {
      if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
      o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = value;
  }
  private unsetPath(path: string): void {
    const keys = path.split('.');
    let o: any = this.doc;
    for (let i = 0; i < keys.length - 1; i++) { if (o == null) return; o = o[keys[i]]; }
    if (o) delete o[keys[keys.length - 1]];
  }
  private applyUpdate(update: any): void {
    if (update.$set) for (const [k, v] of Object.entries(update.$set)) this.setPath(k, v);
    if (update.$unset) for (const k of Object.keys(update.$unset)) this.unsetPath(k);
  }
  findOneAndUpdate(filter: any, update: any, _opts: any): Promise<Task | null> {
    const run = async () => {
      if (!this.matches(filter)) return null;
      this.applyUpdate(update);
      return this.doc;
    };
    const result = this.chain.then(run);
    this.chain = result.catch(() => {});
    return result;
  }
  async updateOne(filter: any, update: any) {
    if (!this.matches(filter)) return { modifiedCount: 0 };
    this.applyUpdate(update);
    return { modifiedCount: 1 };
  }
  async findOne(filter: any) { return this.matches(filter) ? this.doc : null; }
  /** Test helper: mirror a BoardService.moveTask write into the mongo doc. */
  setColumnId(columnId: string): void { (this.doc as any).columnId = columnId; }
}

function makeTask(columnId = 'col_review'): Task {
  return {
    taskId: TASK_ID,
    boardId: 'board_1',
    columnId,
    position: 0,
    title: 'Review me',
    priority: 'high',
    archived: false,
    tags: [],
    assignedAgentId: AGENT,
    running: false,
    dependencies: [],
    progressNotes: [],
    activity: [],
    createdBy: 'agent_x',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Task;
}

const BOARD = {
  boardId: 'board_1',
  projectId: 'proj_1',
  columns: [
    { columnId: 'col_in_progress', name: 'In Progress', slug: 'in_progress' },
    { columnId: 'col_review', name: 'Review', slug: 'review' },
    { columnId: 'col_done', name: 'Done', slug: 'done' },
  ],
};

function makeBoardService(
  task: Task,
  counters: { moves: number; notes: number },
  fake?: FakeTasks,
) {
  // The mock MUTATES both the in-memory task AND the FakeTasks mongo doc, so
  // getTask() (used by shouldApplyGuard) and the claim store stay consistent
  // with what a real BoardService + Mongo would observe after a write.
  return {
    moveTask: mock(async (_taskId: string, _actor: string, columnId: string) => {
      counters.moves++;
      task.columnId = columnId;
      if (fake) fake.setColumnId(columnId);
      return { ...task };
    }),
    addProgressNote: mock(async () => { counters.notes++; return task; }),
    getBoard: mock(async () => BOARD),
    getProject: mock(async () => ({ projectId: 'proj_1', workspaceId: 'work_1' })),
    getTask: mock(async () => task),
  };
}

function makeConn(channelId?: string): any {
  // channelId === undefined simulates the HTTP-transport / race case where
  // setContext never ran (incident #23).
  return { currentChannelId: channelId, currentAgentId: AGENT };
}

function makeCtx(boardService: any, svc: ReviewClaimService): any {
  return { boardService, reviewClaimService: svc, pubSubService: undefined, actionBridgeManager: undefined };
}

// =============================================================================

describe('R1 — session identity resolution', () => {
  it('two sessions with distinct callerChannelId params resolve to distinct identities', async () => {
    const fake = new FakeTasks(makeTask());
    const svc = new ReviewClaimService({ collection: () => fake } as any);
    const counters = { moves: 0, notes: 0 };
    const ctx = makeCtx(makeBoardService(makeTask(), counters), svc);

    // Both sessions pass their own callerChannelId, no connection state at all
    // (the HTTP-MCA path). Exactly one must win.
    const paramsA = { taskId: TASK_ID, text: 'review A', callerChannelId: CH_A };
    const paramsB = { taskId: TASK_ID, text: 'review B', callerChannelId: CH_B };
    const [rA, rB] = await Promise.all([
      handleBoardWriteAction(ctx, 'add_progress_note', paramsA, 'user_1', AGENT, makeConn(undefined)),
      handleBoardWriteAction(ctx, 'add_progress_note', paramsB, 'user_1', AGENT, makeConn(undefined)),
    ]);

    expect(counters.notes).toBe(1);
    const results = [rA, rB] as any[];
    expect(results.filter((r) => r?.skipped === true).length).toBe(1);
    expect(results.filter((r) => r?.task).length).toBe(1);
  });

  it('callerChannelId param wins over connection.currentChannelId (stale-state safe)', async () => {
    const fake = new FakeTasks(makeTask());
    const svc = new ReviewClaimService({ collection: () => fake } as any);
    const counters = { moves: 0, notes: 0 };
    const ctx = makeCtx(makeBoardService(makeTask(), counters), svc);

    // Session A's connection still carries a stale currentChannelId from a
    // previous call, but the param must win.
    const conn = makeConn('ch_STALE');
    const params = { taskId: TASK_ID, text: 'review', callerChannelId: CH_A };
    await handleBoardWriteAction(ctx, 'add_progress_note', params, 'user_1', AGENT, conn);
    const claim = await svc.getClaim(TASK_ID, AGENT);
    expect(claim?.channelId).toBe(CH_A);
  });

  it('no identity anywhere → per-call anonymous id, never the shared unknown-channel constant', async () => {
    const fake = new FakeTasks(makeTask());
    const svc = new ReviewClaimService({ collection: () => fake } as any);
    const counters = { moves: 0, notes: 0 };
    const ctx = makeCtx(makeBoardService(makeTask(), counters), svc);

    // Two parallel sessions, NEITHER has any identity. Pre-v2 both would
    // resolve to 'unknown-channel' and BOTH would acquire via the idempotent
    // re-entry clause. Post-v2 they get distinct anonymous-<uuid> ids, so
    // exactly one wins.
    const params = { taskId: TASK_ID, text: 'anon review' };
    const [rA, rB] = await Promise.all([
      handleBoardWriteAction(ctx, 'add_progress_note', params, 'user_1', AGENT, makeConn(undefined)),
      handleBoardWriteAction(ctx, 'add_progress_note', params, 'user_1', AGENT, makeConn(undefined)),
    ]);

    expect(counters.notes).toBe(1); // exactly one write — the bug is closed
    const claim = await svc.getClaim(TASK_ID, AGENT);
    expect(claim?.channelId).toMatch(/^anonymous-/);
    expect(claim?.channelId).not.toBe('unknown-channel');
    const results = [rA, rB] as any[];
    expect(results.filter((r) => r?.skipped === true).length).toBe(1);
  });

  it('two unidentified calls never share the same generated identity', async () => {
    // Directly exercise the guard to observe resolved identities via the claim log.
    const fake = new FakeTasks(makeTask());
    const svc = new ReviewClaimService({ collection: () => fake } as any);
    const counters = { moves: 0, notes: 0 };
    const ctx = makeCtx(makeBoardService(makeTask(), counters), svc);
    const conn = makeConn(undefined);

    // First call acquires under anonymous-X. Release manually, then a second
    // unidentified call acquires under anonymous-Y. X !== Y.
    const p = { taskId: TASK_ID, text: 'x', reviewAction: true };
    await guardReviewClaim(ctx, conn, 'add_progress_note', TASK_ID, AGENT, p);
    const first = (await svc.getClaim(TASK_ID, AGENT))?.channelId;
    await svc.release(TASK_ID, AGENT, first!);
    await guardReviewClaim(ctx, conn, 'add_progress_note', TASK_ID, AGENT, p);
    const second = (await svc.getClaim(TASK_ID, AGENT))?.channelId;

    expect(first).toMatch(/^anonymous-/);
    expect(second).toMatch(/^anonymous-/);
    expect(first).not.toBe(second);
  });
});

describe('R2 — adoption: server-side review-column inference', () => {
  it('task in review column WITHOUT reviewAction flag → guard still applies (exactly one write)', async () => {
    const fake = new FakeTasks(makeTask('col_review'));
    const svc = new ReviewClaimService({ collection: () => fake } as any);
    const counters = { moves: 0, notes: 0 };
    const ctx = makeCtx(makeBoardService(makeTask('col_review'), counters), svc);

    // The incident-#23 case: sessions reacting to task_moved→Review that
    // forgot the flag. No reviewAction in params at all.
    const paramsA = { taskId: TASK_ID, text: 'review A', callerChannelId: CH_A };
    const paramsB = { taskId: TASK_ID, text: 'review B', callerChannelId: CH_B };
    const [rA, rB] = await Promise.all([
      handleBoardWriteAction(ctx, 'add_progress_note', paramsA, 'user_1', AGENT, makeConn(undefined)),
      handleBoardWriteAction(ctx, 'add_progress_note', paramsB, 'user_1', AGENT, makeConn(undefined)),
    ]);

    expect(counters.notes).toBe(1); // guard applied via slug inference
    const results = [rA, rB] as any[];
    expect(results.filter((r) => r?.skipped === true).length).toBe(1);
  });

  it('AC-3 regression: task in_progress WITHOUT flag → guard does NOT apply (both write)', async () => {
    const fake = new FakeTasks(makeTask('col_in_progress'));
    const svc = new ReviewClaimService({ collection: () => fake } as any);
    const counters = { moves: 0, notes: 0 };
    const ctx = makeCtx(makeBoardService(makeTask('col_in_progress'), counters), svc);

    const params = { taskId: TASK_ID, text: 'normal progress' };
    await handleBoardWriteAction(ctx, 'add_progress_note', params, 'user_1', AGENT, makeConn(CH_A));
    await handleBoardWriteAction(ctx, 'add_progress_note', params, 'user_1', AGENT, makeConn(CH_B));
    expect(counters.notes).toBe(2); // normal progress reporting is NOT guarded
  });

  it('explicit reviewAction:true still forces the guard on a non-review column', async () => {
    const fake = new FakeTasks(makeTask('col_in_progress'));
    const svc = new ReviewClaimService({ collection: () => fake } as any);
    const counters = { moves: 0, notes: 0 };
    const ctx = makeCtx(makeBoardService(makeTask('col_in_progress'), counters), svc);

    const paramsA = { taskId: TASK_ID, text: 'forced A', reviewAction: true, callerChannelId: CH_A };
    const paramsB = { taskId: TASK_ID, text: 'forced B', reviewAction: true, callerChannelId: CH_B };
    const [rA, rB] = await Promise.all([
      handleBoardWriteAction(ctx, 'add_progress_note', paramsA, 'user_1', AGENT, makeConn(undefined)),
      handleBoardWriteAction(ctx, 'add_progress_note', paramsB, 'user_1', AGENT, makeConn(undefined)),
    ]);
    expect(counters.notes).toBe(1);
    const results = [rA, rB] as any[];
    expect(results.filter((r) => r?.skipped === true).length).toBe(1);
  });
});

describe('R3 — fan-out integration (incident #23 replay)', () => {
  it('7 parallel sessions posting a review note → exactly 1 note, 6 skips with reason', async () => {
    const sharedTask = makeTask('col_review');
    const fake = new FakeTasks(sharedTask);
    const svc = new ReviewClaimService({ collection: () => fake } as any);
    const counters = { moves: 0, notes: 0 };
    const ctx = makeCtx(makeBoardService(sharedTask, counters, fake), svc);

    // Post-fix reality: the MCA injects callerChannelId per session. Replay
    // incident #23 with 7 distinct session identities, none passing
    // reviewAction (adoption failure) — the slug inference guards them.
    const sessions = Array.from({ length: 7 }, (_, i) => `ch_session_${i}`);
    const noteCalls = sessions.map((ch) =>
      handleBoardWriteAction(
        ctx,
        'add_progress_note',
        { taskId: TASK_ID, text: 'review note', callerChannelId: ch },
        'user_1',
        AGENT,
        makeConn(undefined),
      ),
    );
    const noteResults = (await Promise.all(noteCalls)) as any[];
    expect(counters.notes).toBe(1);
    const skips = noteResults.filter((r) => r?.skipped === true);
    expect(skips.length).toBe(6);
    for (const skip of skips) {
      expect(typeof skip.reason).toBe('string');
      expect(skip.reason.length).toBeGreaterThan(0);
    }
    // The winner holds the claim under its own channelId.
    const claim = await svc.getClaim(TASK_ID, AGENT);
    expect(claim).toBeDefined();
    expect(sessions).toContain(claim!.channelId);
  });

  it('the winning session can re-enter (note → move) without blocking itself', async () => {
    // Idempotent re-entry: the same channel that posted the note must be able
    // to move the task afterwards (the review's terminal action).
    const sharedTask = makeTask('col_review');
    const fake = new FakeTasks(sharedTask);
    const svc = new ReviewClaimService({ collection: () => fake } as any);
    const counters = { moves: 0, notes: 0 };
    const ctx = makeCtx(makeBoardService(sharedTask, counters, fake), svc);

    await handleBoardWriteAction(
      ctx,
      'add_progress_note',
      { taskId: TASK_ID, text: 'verified', callerChannelId: CH_A },
      'user_1',
      AGENT,
      makeConn(undefined),
    );
    expect(counters.notes).toBe(1);

    const moveResult = (await handleBoardReadAction(
      ctx,
      'move_task',
      { taskId: TASK_ID, columnId: 'col_done', callerChannelId: CH_A },
      'user_1',
      AGENT,
      makeConn(undefined),
    )) as any;
    expect(counters.moves).toBe(1);
    expect(moveResult.skipped).toBeUndefined();
    expect(moveResult.task).toBeTruthy();
    // Terminal action released the claim.
    expect(await svc.getClaim(TASK_ID, AGENT)).toBeUndefined();
  });

  it('fan-out with NO identity anywhere still writes exactly once (fail-closed)', async () => {
    // Even in the worst case (no callerChannelId, no connection state — the
    // exact pre-fix incident conditions), the guard must not duplicate writes.
    // Each call gets its own anonymous-<uuid>, so at most one wins.
    const sharedTask = makeTask('col_review');
    const fake = new FakeTasks(sharedTask);
    const svc = new ReviewClaimService({ collection: () => fake } as any);
    const counters = { moves: 0, notes: 0 };
    const ctx = makeCtx(makeBoardService(sharedTask, counters, fake), svc);

    const noteCalls = Array.from({ length: 7 }, () =>
      handleBoardWriteAction(
        ctx,
        'add_progress_note',
        { taskId: TASK_ID, text: 'review note' },
        'user_1',
        AGENT,
        makeConn(undefined),
      ),
    );
    await Promise.all(noteCalls);
    expect(counters.notes).toBe(1); // THE bug from incident #23 is closed
    const claim = await svc.getClaim(TASK_ID, AGENT);
    expect(claim?.channelId).toMatch(/^anonymous-/);
    expect(claim?.channelId).not.toBe('unknown-channel');
  });
});
