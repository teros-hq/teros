/**
 * Regression for TER-611: the agent-driven `create_project` path must emit a
 * `project.created` websocket event so connected clients' navbars update in
 * realtime — the sibling `create_task` already broadcasts, this path did not.
 *
 * Asserts the exact scope + payload AND the two robustness contracts of the fix:
 *   - broadcastToWorkspace(workspaceId, { type, project, board }) called once
 *   - the broadcast carries through exactly what BoardService.createProject returns
 *   - ctx.pubSubService undefined → the `?.` makes it a no-op, never throws
 *   - a rejecting broadcast is caught (fire-and-forget) → the handler still resolves
 *
 * Pure unit: every service is mocked, no Mongo. Delete the broadcast block in
 * `mca-connection-manager.queries-board-read.ts` (or change the event type) and
 * the first case goes red.
 */

import { describe, expect, it, mock } from 'bun:test'

import { handleBoardReadAction } from '../../src/services/mca-connection-manager.queries-board-read'

const WS = 'work_abc123'
const USER = 'u1'

const newProject = { projectId: 'proj_1', workspaceId: WS, name: 'My Project', description: 'desc' }
const newBoard = { boardId: 'board_1', projectId: 'proj_1', workspaceId: WS }

// Minimal QueryHandlerContext: create_project only touches boardService,
// workspaceService and pubSubService. `broadcastToWorkspace` is async.
function makeCtx(overrides: Record<string, unknown> = {}): any {
  return {
    db: {},
    boardService: {
      createProject: mock(async () => ({ project: newProject, board: newBoard })),
    },
    workspaceService: {
      getUserRole: mock(async () => 'owner'),
    },
    pubSubService: {
      broadcastToWorkspace: mock(async () => {}),
      broadcastToUser: mock(() => {}),
    },
    ...overrides,
  }
}

const PARAMS = { workspaceId: WS, name: 'My Project', description: 'desc' }
const call = (ctx: any) =>
  handleBoardReadAction(ctx, 'create_project', PARAMS, USER, undefined, {} as any)

describe('create_project · broadcast project.created (TER-611)', () => {
  it('broadcasts project.created to the workspace with the exact created payload', async () => {
    const ctx = makeCtx()

    const data = await call(ctx)

    // The handler returns what BoardService.createProject produced…
    expect(data).toEqual({ project: newProject, board: newBoard })

    // …and broadcasts that same payload, scoped to the workspace, exactly once.
    expect(ctx.pubSubService.broadcastToWorkspace).toHaveBeenCalledTimes(1)
    const [wsId, event] = ctx.pubSubService.broadcastToWorkspace.mock.calls[0]
    expect(wsId).toBe(WS)
    expect(event).toEqual({
      type: 'project.created',
      project: newProject,
      board: newBoard,
    })
    // project is workspace-wide news, never a per-user broadcast.
    expect(ctx.pubSubService.broadcastToUser).not.toHaveBeenCalled()
  })

  it('does not throw when pubSubService is not wired (the optional `?.`)', async () => {
    const ctx = makeCtx({ pubSubService: undefined })

    const data = await call(ctx)

    // Resolution still happens; the missing service is a silent no-op, not a crash.
    expect(data).toEqual({ project: newProject, board: newBoard })
  })

  it('a rejecting broadcast is caught and does not fail the creation', async () => {
    const ctx = makeCtx({
      pubSubService: {
        broadcastToWorkspace: mock(async () => {
          throw new Error('transient WS failure')
        }),
        broadcastToUser: mock(() => {}),
      },
    })

    // Fire-and-forget + .catch(): the project was created, so the handler must
    // resolve normally even though the broadcast rejected.
    const data = await call(ctx)
    expect(data).toEqual({ project: newProject, board: newBoard })
  })
})
