/**
 * PubSubService — broadcastToUser / broadcastToWorkspace tests.
 *
 * Verifies:
 *   - broadcastToUser delivers serialised payload to every OPEN session of a user
 *   - closed sessions (readyState !== 1) are skipped
 *   - other users do not receive the payload
 *   - broadcastToWorkspace fans out to owner + members, no duplicates
 *   - missing SessionManager / WorkspaceService → no-op + warning (no throw)
 *   - JSON.stringify is called once per broadcast (not once per recipient)
 */

import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

import type { UserId } from '@teros/shared'
import type { Session, SessionManager } from '../../src/services/session-manager'
import type { WorkspaceService } from '../../src/services/workspace-service'
import { PubSubService } from '../../src/services/pubsub-service'

// PubSubService.init() touches Mongo; we don't call it. Constructor only stores db ref.
const fakeDb = {} as any

type FakeWs = { readyState: number; send: ReturnType<typeof mock> }

function makeWs(open = true): FakeWs {
  return {
    readyState: open ? 1 : 3,
    send: mock(() => {}),
  }
}

function makeSession(userId: string, ws: FakeWs): Session {
  return {
    sessionId: `sess_${Math.random().toString(36).slice(2, 10)}`,
    userId: userId as UserId,
    ws: ws as any,
    connectedAt: new Date(),
    lastActivityAt: new Date(),
  }
}

function makeSessionManager(map: Record<string, Session[]>): SessionManager {
  return {
    getUserSessions: mock((userId: UserId) => map[userId as unknown as string] ?? []),
  } as unknown as SessionManager
}

function makeWorkspaceService(
  workspaces: Record<string, { ownerId: string; members: Array<{ userId: string }> } | null>,
): WorkspaceService {
  return {
    getWorkspace: mock(async (id: string) => workspaces[id] ?? null),
  } as unknown as WorkspaceService
}

// Membership lives in the `workspace_members` collection; broadcastToWorkspace
// reads it through the injected db (find → project → toArray).
function makeMembersDb(members: Record<string, Array<{ userId: string; status?: string }>>): any {
  return {
    collection: (name: string) => ({
      find: (filter: { workspaceId: string }) => ({
        project: () => ({
          toArray: async () => (name === 'workspace_members' ? (members[filter.workspaceId] ?? []) : []),
        }),
      }),
    }),
  }
}

describe('PubSubService.broadcastToUser', () => {
  let logSpy: ReturnType<typeof spyOn>
  let warnSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('delivers payload to every OPEN session of a user', () => {
    const ws1 = makeWs(true)
    const ws2 = makeWs(true)
    const sm = makeSessionManager({
      'user-A': [makeSession('user-A', ws1), makeSession('user-A', ws2)],
    })
    const svc = new PubSubService(fakeDb)
    svc.setSessionManager(sm)

    svc.broadcastToUser('user-A' as UserId, { type: 'agent.created', agent: { agentId: 'a1' } })

    expect(ws1.send).toHaveBeenCalledTimes(1)
    expect(ws2.send).toHaveBeenCalledTimes(1)
    const payload = ws1.send.mock.calls[0][0] as string
    expect(JSON.parse(payload)).toEqual({ type: 'agent.created', agent: { agentId: 'a1' } })
  })

  it('skips sessions that are not OPEN', () => {
    const wsOpen = makeWs(true)
    const wsClosed = makeWs(false)
    const sm = makeSessionManager({
      'user-A': [makeSession('user-A', wsOpen), makeSession('user-A', wsClosed)],
    })
    const svc = new PubSubService(fakeDb)
    svc.setSessionManager(sm)

    svc.broadcastToUser('user-A' as UserId, { type: 'agent.created' })

    expect(wsOpen.send).toHaveBeenCalledTimes(1)
    expect(wsClosed.send).toHaveBeenCalledTimes(0)
  })

  it('does not deliver to other users', () => {
    const wsA = makeWs(true)
    const wsB = makeWs(true)
    const sm = makeSessionManager({
      'user-A': [makeSession('user-A', wsA)],
      'user-B': [makeSession('user-B', wsB)],
    })
    const svc = new PubSubService(fakeDb)
    svc.setSessionManager(sm)

    svc.broadcastToUser('user-A' as UserId, { type: 'agent.created' })

    expect(wsA.send).toHaveBeenCalledTimes(1)
    expect(wsB.send).toHaveBeenCalledTimes(0)
  })

  it('is a no-op + warning when SessionManager is not wired', () => {
    const svc = new PubSubService(fakeDb)
    expect(() => svc.broadcastToUser('user-A' as UserId, { type: 'x' })).not.toThrow()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when user has no sessions', () => {
    const sm = makeSessionManager({})
    const svc = new PubSubService(fakeDb)
    svc.setSessionManager(sm)

    expect(() =>
      svc.broadcastToUser('user-X' as UserId, { type: 'agent.created' }),
    ).not.toThrow()
  })
})

describe('PubSubService.broadcastToWorkspace', () => {
  beforeEach(() => {
    spyOn(console, 'log').mockImplementation(() => {})
    spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('fans out to owner + every member, deduping repeated userIds', async () => {
    const wsOwner = makeWs(true)
    const wsMember1 = makeWs(true)
    const wsMember2 = makeWs(true)
    const sm = makeSessionManager({
      owner: [makeSession('owner', wsOwner)],
      m1: [makeSession('m1', wsMember1)],
      m2: [makeSession('m2', wsMember2)],
    })
    const ws = makeWorkspaceService({
      ws1: { ownerId: 'owner', members: [] },
    })
    const svc = new PubSubService(
      makeMembersDb({ ws1: [{ userId: 'owner' }, { userId: 'm1' }, { userId: 'm2' }, { userId: 'm1' }] }),
    )
    svc.setSessionManager(sm)
    svc.setWorkspaceService(ws)

    await svc.broadcastToWorkspace('ws1', { type: 'project.created' })

    expect(wsOwner.send).toHaveBeenCalledTimes(1)
    expect(wsMember1.send).toHaveBeenCalledTimes(1)
    expect(wsMember2.send).toHaveBeenCalledTimes(1)
  })

  it('serialises the payload only once across the workspace fan-out', async () => {
    const sm = makeSessionManager({
      owner: [makeSession('owner', makeWs(true))],
      m1: [makeSession('m1', makeWs(true))],
      m2: [makeSession('m2', makeWs(true))],
    })
    const ws = makeWorkspaceService({
      ws1: { ownerId: 'owner', members: [] },
    })
    const svc = new PubSubService(
      makeMembersDb({ ws1: [{ userId: 'owner' }, { userId: 'm1' }, { userId: 'm2' }, { userId: 'm1' }] }),
    )
    svc.setSessionManager(sm)
    svc.setWorkspaceService(ws)

    const stringifySpy = spyOn(JSON, 'stringify')
    const callsBefore = stringifySpy.mock.calls.length

    await svc.broadcastToWorkspace('ws1', { type: 'project.created' })

    const callsAfter = stringifySpy.mock.calls.length
    expect(callsAfter - callsBefore).toBe(1)
    stringifySpy.mockRestore()
  })

  it('is a no-op when workspace not found', async () => {
    const sm = makeSessionManager({})
    const ws = makeWorkspaceService({ ws1: null })
    const svc = new PubSubService(fakeDb)
    svc.setSessionManager(sm)
    svc.setWorkspaceService(ws)

    await expect(svc.broadcastToWorkspace('ws1', { type: 'x' })).resolves.toBeUndefined()
  })

  it('is a no-op + warning when workspaceService is not wired', async () => {
    const svc = new PubSubService(fakeDb)
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    await expect(svc.broadcastToWorkspace('ws1', { type: 'x' })).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
  })
})

describe('PubSubService.broadcastToAllSessions', () => {
  let logSpy: ReturnType<typeof spyOn>
  let warnSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  })

  /** Register sessions directly on the service (the path SessionManager.createSession takes). */
  function register(svc: PubSubService, sessions: Array<{ sessionId: string; ws: FakeWs }>): void {
    for (const s of sessions) {
      svc.registerSession(s.sessionId, s.ws as any)
    }
  }

  it('delivers the payload to every OPEN registered session and returns the count', () => {
    const ws1 = makeWs(true)
    const ws2 = makeWs(true)
    const svc = new PubSubService(fakeDb)
    register(svc, [
      { sessionId: 'sess-1', ws: ws1 },
      { sessionId: 'sess-2', ws: ws2 },
    ])

    const sent = svc.broadcastToAllSessions({
      type: 'event',
      event: 'client.refresh',
      data: { reason: 'deploy', maxDelayMs: 30000 },
    })

    expect(sent).toBe(2)
    expect(ws1.send).toHaveBeenCalledTimes(1)
    expect(ws2.send).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(ws1.send.mock.calls[0][0] as string)
    expect(payload).toEqual({
      type: 'event',
      event: 'client.refresh',
      data: { reason: 'deploy', maxDelayMs: 30000 },
    })
  })

  it('skips non-OPEN sessions and reports sent/total separately', () => {
    const wsOpen = makeWs(true)
    const wsClosed = makeWs(false)
    const svc = new PubSubService(fakeDb)
    register(svc, [
      { sessionId: 'sess-open', ws: wsOpen },
      { sessionId: 'sess-closed', ws: wsClosed },
    ])

    const sent = svc.broadcastToAllSessions({ type: 'event', event: 'client.refresh' })

    expect(sent).toBe(1)
    expect(svc.getRegisteredSessionCount()).toBe(2)
    expect(wsOpen.send).toHaveBeenCalledTimes(1)
    expect(wsClosed.send).toHaveBeenCalledTimes(0)
  })

  it('reaches sessions regardless of user identity (no SessionManager needed)', () => {
    // broadcastToAllSessions iterates the internal sessionMap — it must work
    // even with no SessionManager wired (the admin deploy signal cannot
    // depend on per-user lookups).
    const ws = makeWs(true)
    const svc = new PubSubService(fakeDb)
    register(svc, [{ sessionId: 'sess-x', ws }])

    const sent = svc.broadcastToAllSessions({ type: 'event', event: 'client.refresh' })

    expect(sent).toBe(1)
    expect(ws.send).toHaveBeenCalledTimes(1)
    // (No warn assertion: bun spyOn state is shared across describe blocks in
    // this file when not restored — earlier blocks legitimately warn twice.)
  })

  it('returns 0 when no sessions are registered', () => {
    const svc = new PubSubService(fakeDb)
    expect(svc.broadcastToAllSessions({ type: 'x' })).toBe(0)
    expect(svc.getRegisteredSessionCount()).toBe(0)
  })

  it('serializes the payload once regardless of recipient count', () => {
    const svc = new PubSubService(fakeDb)
    register(svc, [
      { sessionId: 's1', ws: makeWs(true) },
      { sessionId: 's2', ws: makeWs(true) },
      { sessionId: 's3', ws: makeWs(true) },
    ])

    const stringifySpy = spyOn(JSON, 'stringify')
    const callsBefore = stringifySpy.mock.calls.length
    svc.broadcastToAllSessions({ type: 'event', event: 'client.refresh' })
    const callsAfter = stringifySpy.mock.calls.length
    expect(callsAfter - callsBefore).toBe(1)
    stringifySpy.mockRestore()
  })
})
