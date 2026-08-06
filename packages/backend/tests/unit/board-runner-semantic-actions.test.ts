/**
 * Unit tests for the three semantic runner actions:
 *   board.complete-my-task
 *   board.block-my-task
 *   board.cancel-my-task
 *
 * These handlers replace move-my-task in the board-runner MCA.
 * They resolve the target column by slug — the runner never handles columnIds.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { createCompleteMyTaskHandler } from '../../src/handlers/domains/board/complete-my-task';
import { createBlockMyTaskHandler } from '../../src/handlers/domains/board/block-my-task';
import { createCancelMyTaskHandler } from '../../src/handlers/domains/board/cancel-my-task';

// =============================================================================
// HELPERS
// =============================================================================

const AGENT_ID = 'agent_runner_1';
const OTHER_AGENT_ID = 'agent_other_1';
const TASK_ID = 'task_abc123';
const BOARD_ID = 'board_xyz';
const PROJECT_ID = 'project_xyz';
const WORKSPACE_ID = 'workspace_xyz';

const baseCtx = { userId: 'user_1', sessionId: 'sess_1' } as any;

function makeColumns() {
  return [
    { columnId: 'col_backlog', name: 'Backlog', slug: 'backlog' },
    { columnId: 'col_todo', name: 'To Do', slug: 'todo' },
    { columnId: 'col_in_progress', name: 'In Progress', slug: 'in_progress' },
    { columnId: 'col_blocked', name: 'Blocked', slug: 'blocked' },
    { columnId: 'col_review', name: 'Review', slug: 'review' },
    { columnId: 'col_done', name: 'Done', slug: 'done' },
  ];
}

function makeTask(overrides: Partial<any> = {}): any {
  return {
    taskId: TASK_ID,
    boardId: BOARD_ID,
    columnId: 'col_in_progress',
    assignedAgentId: AGENT_ID,
    title: 'Test task',
    running: true,
    archived: false,
    ...overrides,
  };
}

function makeBoard(): any {
  return {
    boardId: BOARD_ID,
    projectId: PROJECT_ID,
    columns: makeColumns(),
  };
}

function makeProject(): any {
  return {
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
  };
}

function makeBoardService(taskOverrides: Partial<any> = {}): any {
  const task = makeTask(taskOverrides);
  const board = makeBoard();
  const project = makeProject();

  return {
    getTask: mock(async () => task),
    getBoard: mock(async () => board),
    getProject: mock(async () => project),
    moveTask: mock(async () => ({ ...task, columnId: 'col_review' })),
    setRunning: mock(async () => null),
    clearStopRequest: mock(async () => null),
    addProgressNote: mock(async () => task),
    archiveTask: mock(async () => ({ ...task, archived: true })),
    getDependentTasks: mock(async () => []),
  };
}

function makeWorkspaceService(role: string | null = 'write'): any {
  return {
    getUserRole: mock(async () => role),
  };
}

function makePubSubService(): any {
  return {
    broadcastToTopic: mock(() => {}),
  };
}

function makeAutoplayService(): any {
  return {
    scheduleAgentTasks: mock(() => {}),
  };
}

function makeBoardSubscriptionService(): any {
  return {
    notifySubscribers: mock(() => {}),
  };
}

// =============================================================================
// complete-my-task
// =============================================================================

describe('complete-my-task handler', () => {
  it('moves task to Review column by slug', async () => {
    const boardService = makeBoardService();
    const workspaceService = makeWorkspaceService();
    const pubSubService = makePubSubService();
    const autoplayService = makeAutoplayService();

    const handler = createCompleteMyTaskHandler(
      boardService, workspaceService, pubSubService, autoplayService,
    );

    const result = await handler(baseCtx, { taskId: TASK_ID, agentId: AGENT_ID });

    expect(result.task).toBeDefined();
    // moveTask was called with the Review column ID (resolved by slug)
    expect(boardService.moveTask).toHaveBeenCalledWith(TASK_ID, AGENT_ID, 'col_review');
  });

  it('clears running flag after moving', async () => {
    const boardService = makeBoardService();
    const handler = createCompleteMyTaskHandler(
      boardService, makeWorkspaceService(), makePubSubService(),
    );

    await handler(baseCtx, { taskId: TASK_ID, agentId: AGENT_ID });

    expect(boardService.setRunning).toHaveBeenCalledWith(TASK_ID, false);
  });

  it('triggers autoplay scheduling after completing', async () => {
    const boardService = makeBoardService();
    const autoplayService = makeAutoplayService();

    const handler = createCompleteMyTaskHandler(
      boardService, makeWorkspaceService(), makePubSubService(), autoplayService,
    );

    await handler(baseCtx, { taskId: TASK_ID, agentId: AGENT_ID });

    expect(autoplayService.scheduleAgentTasks).toHaveBeenCalledWith(PROJECT_ID, AGENT_ID);
  });

  it('throws FORBIDDEN when task is not assigned to calling agent', async () => {
    const boardService = makeBoardService({ assignedAgentId: OTHER_AGENT_ID });
    const handler = createCompleteMyTaskHandler(
      boardService, makeWorkspaceService(), makePubSubService(),
    );

    await expect(
      handler(baseCtx, { taskId: TASK_ID, agentId: AGENT_ID }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('throws NOT_FOUND when task does not exist', async () => {
    const boardService = makeBoardService();
    boardService.getTask = mock(async () => null);

    const handler = createCompleteMyTaskHandler(
      boardService, makeWorkspaceService(), makePubSubService(),
    );

    await expect(
      handler(baseCtx, { taskId: TASK_ID, agentId: AGENT_ID }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws MISSING_FIELDS when taskId or agentId missing', async () => {
    const handler = createCompleteMyTaskHandler(
      makeBoardService(), makeWorkspaceService(), makePubSubService(),
    );

    await expect(
      handler(baseCtx, { agentId: AGENT_ID }),
    ).rejects.toMatchObject({ code: 'MISSING_FIELDS' });

    await expect(
      handler(baseCtx, { taskId: TASK_ID }),
    ).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
  });

  it('throws NOT_FOUND when Review column is missing from board', async () => {
    const boardService = makeBoardService();
    // Board with no review column
    boardService.getBoard = mock(async () => ({
      boardId: BOARD_ID,
      projectId: PROJECT_ID,
      columns: makeColumns().filter((c) => c.slug !== 'review'),
    }));

    const handler = createCompleteMyTaskHandler(
      boardService, makeWorkspaceService(), makePubSubService(),
    );

    await expect(
      handler(baseCtx, { taskId: TASK_ID, agentId: AGENT_ID }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('works from any source column including Blocked', async () => {
    const boardService = makeBoardService({ columnId: 'col_blocked' });
    const handler = createCompleteMyTaskHandler(
      boardService, makeWorkspaceService(), makePubSubService(),
    );

    const result = await handler(baseCtx, { taskId: TASK_ID, agentId: AGENT_ID });

    expect(result.task).toBeDefined();
    expect(boardService.moveTask).toHaveBeenCalledWith(TASK_ID, AGENT_ID, 'col_review');
  });
});

// =============================================================================
// block-my-task
// =============================================================================

describe('block-my-task handler', () => {
  it('moves task to Blocked column by slug', async () => {
    const boardService = makeBoardService();
    const handler = createBlockMyTaskHandler(
      boardService, makeWorkspaceService(), makePubSubService(),
    );

    await handler(baseCtx, { taskId: TASK_ID, reason: 'Waiting for API key', agentId: AGENT_ID });

    expect(boardService.moveTask).toHaveBeenCalledWith(TASK_ID, AGENT_ID, 'col_blocked');
  });

  it('adds a progress note with the reason before moving', async () => {
    const boardService = makeBoardService();
    const callOrder: string[] = [];
    boardService.addProgressNote = mock(async () => { callOrder.push('note'); return makeTask(); });
    boardService.moveTask = mock(async () => { callOrder.push('move'); return makeTask(); });

    const handler = createBlockMyTaskHandler(
      boardService, makeWorkspaceService(), makePubSubService(),
    );

    await handler(baseCtx, { taskId: TASK_ID, reason: 'Need credentials', agentId: AGENT_ID });

    expect(boardService.addProgressNote).toHaveBeenCalledWith(
      TASK_ID, '🚧 Blocked: Need credentials', AGENT_ID,
    );
    // note must come before move
    expect(callOrder).toEqual(['note', 'move']);
  });

  it('clears running flag after moving', async () => {
    const boardService = makeBoardService();
    const handler = createBlockMyTaskHandler(
      boardService, makeWorkspaceService(), makePubSubService(),
    );

    await handler(baseCtx, { taskId: TASK_ID, reason: 'Blocked', agentId: AGENT_ID });

    expect(boardService.setRunning).toHaveBeenCalledWith(TASK_ID, false);
  });

  it('throws FORBIDDEN when task is not assigned to calling agent', async () => {
    const boardService = makeBoardService({ assignedAgentId: OTHER_AGENT_ID });
    const handler = createBlockMyTaskHandler(
      boardService, makeWorkspaceService(), makePubSubService(),
    );

    await expect(
      handler(baseCtx, { taskId: TASK_ID, reason: 'x', agentId: AGENT_ID }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('throws MISSING_FIELDS when reason is missing', async () => {
    const handler = createBlockMyTaskHandler(
      makeBoardService(), makeWorkspaceService(), makePubSubService(),
    );

    await expect(
      handler(baseCtx, { taskId: TASK_ID, agentId: AGENT_ID }),
    ).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
  });

  it('throws NOT_FOUND when Blocked column is missing from board', async () => {
    const boardService = makeBoardService();
    boardService.getBoard = mock(async () => ({
      boardId: BOARD_ID,
      projectId: PROJECT_ID,
      columns: makeColumns().filter((c) => c.slug !== 'blocked'),
    }));

    const handler = createBlockMyTaskHandler(
      boardService, makeWorkspaceService(), makePubSubService(),
    );

    await expect(
      handler(baseCtx, { taskId: TASK_ID, reason: 'x', agentId: AGENT_ID }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('does NOT trigger autoplay (blocking does not free a slot)', async () => {
    const boardService = makeBoardService();
    const autoplayService = makeAutoplayService();

    // block-my-task does not receive autoplayService — that's by design
    const handler = createBlockMyTaskHandler(
      boardService, makeWorkspaceService(), makePubSubService(),
    );

    await handler(baseCtx, { taskId: TASK_ID, reason: 'blocked', agentId: AGENT_ID });

    expect(autoplayService.scheduleAgentTasks).not.toHaveBeenCalled();
  });
});

// =============================================================================
// cancel-my-task
// =============================================================================

describe('cancel-my-task handler', () => {
  it('archives the task in-place (does not move it)', async () => {
    const boardService = makeBoardService();
    const handler = createCancelMyTaskHandler(
      boardService, makeWorkspaceService(), makePubSubService(),
    );

    await handler(baseCtx, { taskId: TASK_ID, reason: 'Duplicate task', agentId: AGENT_ID });

    // archive called
    expect(boardService.archiveTask).toHaveBeenCalledWith(
      TASK_ID, AGENT_ID, expect.stringContaining('Duplicate task'),
    );
    // moveTask NOT called
    expect(boardService.moveTask).not.toHaveBeenCalled();
  });

  it('adds a progress note with the reason before archiving', async () => {
    const boardService = makeBoardService();
    const callOrder: string[] = [];
    boardService.addProgressNote = mock(async () => { callOrder.push('note'); return makeTask(); });
    boardService.archiveTask = mock(async () => { callOrder.push('archive'); return { ...makeTask(), archived: true }; });

    const handler = createCancelMyTaskHandler(
      boardService, makeWorkspaceService(), makePubSubService(),
    );

    await handler(baseCtx, { taskId: TASK_ID, reason: 'No longer needed', agentId: AGENT_ID });

    expect(boardService.addProgressNote).toHaveBeenCalledWith(
      TASK_ID, '❌ Cancelled: No longer needed', AGENT_ID,
    );
    expect(callOrder).toEqual(['note', 'archive']);
  });

  it('clears running flag before archiving', async () => {
    const boardService = makeBoardService();
    const callOrder: string[] = [];
    boardService.setRunning = mock(async () => { callOrder.push('setRunning'); return null; });
    boardService.archiveTask = mock(async () => { callOrder.push('archive'); return { ...makeTask(), archived: true }; });

    const handler = createCancelMyTaskHandler(
      boardService, makeWorkspaceService(), makePubSubService(),
    );

    await handler(baseCtx, { taskId: TASK_ID, reason: 'cancelled', agentId: AGENT_ID });

    expect(boardService.setRunning).toHaveBeenCalledWith(TASK_ID, false);
    expect(callOrder).toEqual(['setRunning', 'archive']);
  });

  it('throws FORBIDDEN when task is not assigned to calling agent', async () => {
    const boardService = makeBoardService({ assignedAgentId: OTHER_AGENT_ID });
    const handler = createCancelMyTaskHandler(
      boardService, makeWorkspaceService(), makePubSubService(),
    );

    await expect(
      handler(baseCtx, { taskId: TASK_ID, reason: 'x', agentId: AGENT_ID }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('throws MISSING_FIELDS when reason is missing', async () => {
    const handler = createCancelMyTaskHandler(
      makeBoardService(), makeWorkspaceService(), makePubSubService(),
    );

    await expect(
      handler(baseCtx, { taskId: TASK_ID, agentId: AGENT_ID }),
    ).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
  });

  it('throws NOT_FOUND when task does not exist', async () => {
    const boardService = makeBoardService();
    boardService.getTask = mock(async () => null);

    const handler = createCancelMyTaskHandler(
      boardService, makeWorkspaceService(), makePubSubService(),
    );

    await expect(
      handler(baseCtx, { taskId: TASK_ID, reason: 'x', agentId: AGENT_ID }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('works from any column (Blocked, In Progress, To Do, etc.)', async () => {
    for (const columnId of ['col_blocked', 'col_in_progress', 'col_todo', 'col_backlog']) {
      const boardService = makeBoardService({ columnId });
      const handler = createCancelMyTaskHandler(
        boardService, makeWorkspaceService(), makePubSubService(),
      );

      const result = await handler(baseCtx, { taskId: TASK_ID, reason: 'cancelled', agentId: AGENT_ID });

      expect(result.task).toBeDefined();
      expect(boardService.moveTask).not.toHaveBeenCalled();
    }
  });
});
