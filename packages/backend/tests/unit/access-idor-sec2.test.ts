/**
 * SEC-2 (TER-721) regression tests — cross-tenant access / IDOR gaps.
 *
 * A2: channel creation (channel.create, channel.create-with-message, voice)
 *     stamped ctx.userId + a client-supplied workspaceId/agentId with NO check
 *     that the caller belongs to the workspace or may use the agent → a member
 *     could drive another tenant's private agent (its apps + secrets).
 * A3: /api/files resolved an arbitrary workspaceId/channelId with no membership
 *     check → any logged-in user read another workspace's files.
 * M4: /uploads (and /public) had no path-containment guard → traversal.
 * M5: board.get-task-by-channel skipped the channel-access check on purpose.
 *
 * These tests MORDER: denied cases assert the protected effect (createChannel /
 * getTaskByChannel / file read) is NEVER reached, the agent predicate is
 * evaluated faithfully (a real in-memory Mongo-filter matcher, not a hardcoded
 * boolean), and code + message are asserted exactly. No real MongoDB.
 */

import { describe, expect, it, mock } from 'bun:test'
import type { WsHandlerContext } from '@teros/shared'
import { resolveWithinDir } from '../../src/bootstrap/http-server'
import { createGetTaskByChannelHandler } from '../../src/handlers/domains/board/get-task-by-channel'
import { createCreateChannelHandler } from '../../src/handlers/domains/channel/create'
import { createCreateWithMessageHandler } from '../../src/handlers/domains/channel/create-with-message'
import { HttpFileHandler } from '../../src/handlers/http-file-handler'
import { assertCanCreateChannel, usableAgentFilter } from '../../src/services/channel-authz'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER = 'user_me'
const VICTIM = 'user_victim'
const WS = 'work_mine'
const WS_OTHER_OWNER = 'user_wsowner'

function ctx(userId: string): WsHandlerContext {
  return { userId, connectionId: 'c', sessionId: 's' } as WsHandlerContext
}

/**
 * Faithful in-memory evaluator for the exact Mongo filter shape produced by
 * usableAgentFilter: top-level scalar equality, `$or`, `$in`, and the
 * `{ $in: [null, undefined] }` "field absent-or-null" idiom. This is what makes
 * the A2 tests MORDER — the predicate is really evaluated, so weakening it
 * (e.g. dropping the ownerId clause) changes the outcome.
 */
function matchesFilter(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, v]) => {
    if (k === '$or') return (v as Record<string, unknown>[]).some((sub) => matchesFilter(doc, sub))
    if (v && typeof v === 'object' && '$in' in (v as Record<string, unknown>)) {
      const list = (v as { $in: unknown[] }).$in
      const dv = doc[k]
      return list.some((x) => x === dv || (x == null && dv == null))
    }
    return doc[k] === v
  })
}

function fakeDb(opts: {
  agents?: Record<string, unknown>[]
  workspaces?: Record<string, unknown>[]
}): any {
  const agents = opts.agents ?? []
  const workspaces = opts.workspaces ?? []
  return {
    collection: (name: string) => {
      const docs = name === 'agents' ? agents : name === 'workspaces' ? workspaces : []
      return { findOne: async (filter: Record<string, unknown>) => docs.find((d) => matchesFilter(d, filter)) ?? null }
    },
  }
}

// The workspace `WS` is owned by USER; WS members are USER (+ optional extras).
const wsOwnedByUser = { workspaceId: WS, ownerId: USER }

const AGENT_SUPER_MINE = { agentId: 'agent_super_mine', ownerId: USER, workspaceId: null }
const AGENT_WS_SCOPED = { agentId: 'agent_ws', workspaceId: WS }
const AGENT_SUPER_WSOWNER = { agentId: 'agent_super_owner', ownerId: WS_OTHER_OWNER, workspaceId: null }
const AGENT_VICTIM_PRIVATE = { agentId: 'agent_victim', ownerId: VICTIM, workspaceId: 'work_victim' }

const ALL_AGENTS = [AGENT_SUPER_MINE, AGENT_WS_SCOPED, AGENT_SUPER_WSOWNER, AGENT_VICTIM_PRIVATE]

// ===========================================================================
// A2 — usableAgentFilter shape (shared with agent.list; must not drift)
// ===========================================================================

describe('usableAgentFilter (A2 shared predicate)', () => {
  it('emits workspace clause + caller/owner superagent clause', () => {
    expect(usableAgentFilter(USER, WS, WS_OTHER_OWNER)).toEqual({
      $or: [
        { workspaceId: WS },
        { ownerId: { $in: [USER, WS_OTHER_OWNER] }, workspaceId: { $in: [null, undefined] } },
      ],
    })
  })

  it('dedups the owner id when caller === workspace owner', () => {
    expect(usableAgentFilter(USER, WS, USER)).toEqual({
      $or: [
        { workspaceId: WS },
        { ownerId: { $in: [USER] }, workspaceId: { $in: [null, undefined] } },
      ],
    })
  })

  it('omits a null/undefined workspace owner from the $in', () => {
    expect(usableAgentFilter(USER, WS, null)).toEqual({
      $or: [
        { workspaceId: WS },
        { ownerId: { $in: [USER] }, workspaceId: { $in: [null, undefined] } },
      ],
    })
  })
})

// ===========================================================================
// A2 — assertCanCreateChannel decision (the load-bearing gate)
// ===========================================================================

function wsService(canAccess: boolean): any {
  return { canAccess: mock(async () => canAccess) }
}

describe('assertCanCreateChannel (A2)', () => {
  it('rejects a non-member of the workspace', async () => {
    const db = fakeDb({ agents: ALL_AGENTS, workspaces: [wsOwnedByUser] })
    await expect(
      assertCanCreateChannel(db, wsService(false), USER, WS, AGENT_WS_SCOPED.agentId),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED', message: 'You do not have access to this workspace' })
  })

  it('rejects when workspaceService is missing (fail closed)', async () => {
    const db = fakeDb({ agents: ALL_AGENTS, workspaces: [wsOwnedByUser] })
    await expect(
      assertCanCreateChannel(db, null, USER, WS, AGENT_WS_SCOPED.agentId),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_CONFIGURED' })
  })

  it('allows a member using a workspace-scoped agent', async () => {
    const db = fakeDb({ agents: ALL_AGENTS, workspaces: [wsOwnedByUser] })
    await expect(
      assertCanCreateChannel(db, wsService(true), USER, WS, AGENT_WS_SCOPED.agentId),
    ).resolves.toBeUndefined()
  })

  it('allows a member using their own superagent (workspaceId null)', async () => {
    const db = fakeDb({ agents: ALL_AGENTS, workspaces: [wsOwnedByUser] })
    await expect(
      assertCanCreateChannel(db, wsService(true), USER, WS, AGENT_SUPER_MINE.agentId),
    ).resolves.toBeUndefined()
  })

  it("allows a member using the workspace owner's superagent", async () => {
    // WS is owned by WS_OTHER_OWNER here; USER is a member (canAccess true).
    const db = fakeDb({ agents: ALL_AGENTS, workspaces: [{ workspaceId: WS, ownerId: WS_OTHER_OWNER }] })
    await expect(
      assertCanCreateChannel(db, wsService(true), USER, WS, AGENT_SUPER_WSOWNER.agentId),
    ).resolves.toBeUndefined()
  })

  it("DENIES a member stamping their OWN workspace + a victim's private agent (load-bearing)", async () => {
    // canAccess(WS, USER) === true (own workspace) — membership alone does NOT
    // close this. Only the agent predicate does: the victim's private agent is
    // neither workspace-scoped to WS nor a superagent of USER/WS owner.
    const db = fakeDb({ agents: ALL_AGENTS, workspaces: [wsOwnedByUser] })
    await expect(
      assertCanCreateChannel(db, wsService(true), USER, WS, AGENT_VICTIM_PRIVATE.agentId),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED', message: 'You do not have access to this agent' })
  })

  it('rejects an unknown agentId', async () => {
    const db = fakeDb({ agents: ALL_AGENTS, workspaces: [wsOwnedByUser] })
    await expect(
      assertCanCreateChannel(db, wsService(true), USER, WS, 'agent_does_not_exist'),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED', message: 'You do not have access to this agent' })
  })
})

// ===========================================================================
// A2 — each channel-creation handler wires the gate (parallel paths)
// ===========================================================================

describe('channel.create handler wires the A2 gate', () => {
  it('rejects a non-member and never creates a channel', async () => {
    const createChannel = mock(async () => ({ channelId: 'ch_x' }))
    const channelManager: any = { createChannel }
    const db = fakeDb({ agents: ALL_AGENTS, workspaces: [wsOwnedByUser] })
    const handler = createCreateChannelHandler(channelManager, {} as any, wsService(false), db)

    await expect(
      handler(ctx(USER), { agentId: AGENT_WS_SCOPED.agentId, workspaceId: WS }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' })

    expect(createChannel).not.toHaveBeenCalled()
  })
})

describe('channel.create-with-message handler wires the A2 gate', () => {
  it('rejects a non-member and never creates a channel', async () => {
    const createChannel = mock(async () => ({ channelId: 'ch_x' }))
    const channelManager: any = { createChannel }
    const messageHandler: any = { handleSendMessage: mock(async () => {}) }
    const db = fakeDb({ agents: ALL_AGENTS, workspaces: [wsOwnedByUser] })
    const handler = createCreateWithMessageHandler({
      channelManager,
      sessionManager: {} as any,
      pubSubService: {} as any,
      messageHandler,
      workspaceService: wsService(false),
      db,
      getSessionId: () => undefined,
    })

    await expect(
      handler({ ...ctx(USER), ws: {} as any }, { agentId: AGENT_WS_SCOPED.agentId, workspaceId: WS, content: {} }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' })

    expect(createChannel).not.toHaveBeenCalled()
    expect(messageHandler.handleSendMessage).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// M5 — board.get-task-by-channel enforces channel access
// ===========================================================================

describe('board.get-task-by-channel gate (M5)', () => {
  it('rejects when the caller cannot access the channel and never reads the task', async () => {
    const getTaskByChannel = mock(async () => ({ taskId: 't' }))
    const boardService: any = { getTaskByChannel }
    const channelManager: any = { canAccessChannel: mock(async () => false) }
    const handler = createGetTaskByChannelHandler(boardService, channelManager)

    await expect(handler(ctx(USER), { channelId: 'ch_victim' })).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
      message: 'You do not have access to this channel',
    })
    expect(getTaskByChannel).not.toHaveBeenCalled()
  })

  it('returns the task when the caller can access the channel', async () => {
    const task = { taskId: 't', title: 'x' }
    const boardService: any = { getTaskByChannel: mock(async () => task) }
    const channelManager: any = { canAccessChannel: mock(async () => true) }
    const handler = createGetTaskByChannelHandler(boardService, channelManager)

    expect(await handler(ctx(USER), { channelId: 'ch_mine' })).toEqual({ channelId: 'ch_mine', task })
  })
})

// ===========================================================================
// A3 — /api/files enforces membership on the SAME context it resolves
// ===========================================================================

function fakeRes(): any {
  return {
    statusCode: 0,
    body: '',
    writeHead(code: number) {
      this.statusCode = code
    },
    end(body?: string) {
      this.body = body ?? ''
    },
  }
}

function fakeReq(): any {
  return { method: 'GET', headers: { host: 'localhost', authorization: 'Bearer tok' } }
}

const authOk: any = { validateSession: async () => ({ success: true, user: { userId: USER } }) }

describe('/api/files membership gate (A3)', () => {
  it('403 for a non-member when a workspaceId is supplied (never resolves the path)', async () => {
    const workspaceService: any = { canAccess: mock(async () => false) }
    const channelManager: any = { canAccessChannel: mock(async () => false) }
    const h = new HttpFileHandler({} as any, authOk, {} as any, workspaceService, channelManager)
    const res = fakeRes()

    await h.handleRoute(fakeReq(), res, '/api/files?path=/workspace/f.html&workspaceId=work_victim')

    expect(res.statusCode).toBe(403)
    expect(workspaceService.canAccess).toHaveBeenCalledWith('work_victim', USER)
  })

  it('403 for a non-member when only a channelId is supplied (channel precedence)', async () => {
    const workspaceService: any = { canAccess: mock(async () => true) }
    const channelManager: any = { canAccessChannel: mock(async () => false) }
    const h = new HttpFileHandler({} as any, authOk, {} as any, workspaceService, channelManager)
    const res = fakeRes()

    await h.handleRoute(fakeReq(), res, '/api/files?path=/workspace/f.html&channelId=ch_victim')

    expect(res.statusCode).toBe(403)
    expect(channelManager.canAccessChannel).toHaveBeenCalledWith('ch_victim', USER)
    // workspaceId absent → the workspace check must NOT decide this request
    expect(workspaceService.canAccess).not.toHaveBeenCalled()
  })

  it('passes the gate for a member (fails later at volume resolution, not with 403)', async () => {
    const workspaceService: any = {
      canAccess: mock(async () => true),
      getWorkspace: mock(async () => undefined), // no volume → resolution throws → 400
    }
    const channelManager: any = { canAccessChannel: mock(async () => true) }
    const db = { collection: () => ({ findOne: async () => null }) }
    const h = new HttpFileHandler(db as any, authOk, {} as any, workspaceService, channelManager)
    const res = fakeRes()

    await h.handleRoute(fakeReq(), res, '/api/files?path=/workspace/f.html&workspaceId=work_mine')

    expect(res.statusCode).not.toBe(403)
    expect(res.statusCode).toBe(400)
  })

  it('401 before any authorization when the session is invalid', async () => {
    const authBad: any = { validateSession: async () => ({ success: false }) }
    const workspaceService: any = { canAccess: mock(async () => true) }
    const h = new HttpFileHandler({} as any, authBad, {} as any, workspaceService, { canAccessChannel: mock(async () => true) } as any)
    const res = fakeRes()

    await h.handleRoute(fakeReq(), res, '/api/files?path=/workspace/f.html&workspaceId=work_mine')

    expect(res.statusCode).toBe(401)
    expect(workspaceService.canAccess).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// M4 — path-containment guard
// ===========================================================================

describe('resolveWithinDir (M4)', () => {
  it('returns the joined path for a plain filename', () => {
    expect(resolveWithinDir('/srv/uploads', 'user/1700000000.wav')).toBe('/srv/uploads/user/1700000000.wav')
  })

  it('collapses harmless inner ".." that stays inside', () => {
    expect(resolveWithinDir('/srv/uploads', 'a/../b.wav')).toBe('/srv/uploads/b.wav')
  })

  it('rejects a traversal escape', () => {
    expect(resolveWithinDir('/srv/uploads', '../../etc/passwd')).toBeNull()
  })

  it('rejects an absolute path escape', () => {
    expect(resolveWithinDir('/srv/uploads', '/etc/passwd')).toBeNull()
  })

  it('rejects a sibling-prefix escape (uploads-evil)', () => {
    expect(resolveWithinDir('/srv/uploads', '../uploads-evil/x')).toBeNull()
  })
})
