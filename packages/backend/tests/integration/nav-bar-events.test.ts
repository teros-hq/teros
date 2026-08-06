/**
 * NavBar realtime events — integration tests (TER-304)
 *
 * End-to-end exercise of the broadcast pipeline:
 *   handler → PubSubService.broadcastTo{User,Workspace} → ws.send → client
 *
 * Two users (A=owner, B=member of workspace W) connect over real WebSockets
 * to a TestServer wired with the full domain stack (`enableNavbarStack: true`).
 * For each domain we trigger a state change via the WsFramework protocol and
 * assert which clients receive the broadcast — validating both the emit
 * (handler-level wiring) and the scope (workspace fan-out vs user-only).
 *
 * A third client (C, not a member) is used for the negative case to confirm
 * unrelated users don't receive workspace-scoped events.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import {
  createTestServer,
  type TestServerInstance,
  TestWebSocketClient,
} from '@teros/testing'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function req(action: string, data: Record<string, unknown> = {}, requestId = `req_${Math.random().toString(36).slice(2, 8)}`) {
  return { type: 'request', requestId, action, data }
}

async function sendAndWaitForResponse(
  client: TestWebSocketClient,
  action: string,
  data: Record<string, unknown> = {},
): Promise<any> {
  const requestId = `req_${Math.random().toString(36).slice(2, 8)}`
  client.send({ type: 'request', requestId, action, data })
  const response = await client.waitFor(
    (msg: any) =>
      (msg.type === 'response' || msg.type === 'error') && msg.requestId === requestId,
    8000,
  )
  if (response.type === 'error') {
    throw new Error(`${action} failed: ${response.code} — ${response.error ?? response.message}`)
  }
  return response.data
}

function waitForBroadcast(
  client: TestWebSocketClient,
  type: string,
  timeoutMs = 5000,
): Promise<any> {
  return client.waitFor((msg: any) => msg.type === type, timeoutMs)
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('NavBar realtime events (TER-304)', () => {
  let server: TestServerInstance
  // Two test workspaces — one shared (W) with B as member, one private for A.
  let workspaceId: string
  // Mca catalog entry for app.install/uninstall tests
  const TEST_MCA_ID = 'mca:test-fixture'

  const userAEmail = 'user1@test.com'
  const userBEmail = 'user2@test.com'
  const userCEmail = 'pablo@teros.ai' // outsider — seeded but NOT added to W
  // MockAuthHandler converts email → userId by `user:test_<localPart>`
  const userAId = 'user:test_user1'
  const userBId = 'user:test_user2'

  beforeAll(async () => {
    server = await createTestServer({
      enableNavbarStack: true,
      mockResponses: [{ text: 'mock' }],
    })
    await server.seedAgents()

    // Seed an MCA catalog entry so app.install can succeed.
    // multi: true lets the same user install the MCA multiple times — each
    // install creates a distinct App and emits its own broadcast (otherwise
    // the second install short-circuits to "return existing" with no event).
    await server.db.collection('mca_catalog').insertOne({
      mcaId: TEST_MCA_ID,
      name: 'Test Fixture',
      description: 'Test MCA used by nav-bar-events integration tests',
      icon: 'test.png',
      color: '#abcdef',
      category: 'test',
      availability: { enabled: true, role: 'user', multi: true },
      runtime: { transport: 'http' },
      tools: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    // Each user needs a private workspace so app.install resolves ownerId.
    const ws = server.workspaceService!
    const privA = await ws.createPrivateWorkspace(userAId)
    const privB = await ws.createPrivateWorkspace(userBId)
    await server.db.collection('users').updateOne(
      { userId: userAId },
      { $set: { privateWorkspaceId: privA.workspaceId } },
    )
    await server.db.collection('users').updateOne(
      { userId: userBId },
      { $set: { privateWorkspaceId: privB.workspaceId } },
    )
  })

  afterAll(async () => {
    if (server) await server.close()
  })

  // Each test starts with a fresh shared workspace W (A=owner, B=member). Re-use
  // would tangle archived state across tests.
  beforeEach(async () => {
    const w = await server.workspaceService!.createWorkspace(userAId, {
      name: `Shared W ${Date.now()}`,
      type: 'shared',
    })
    workspaceId = w.workspaceId
    await server.workspaceService!.addMember(workspaceId, userBId, 'write', userAId)
  })

  // -----------------------------------------------------------------------
  // agent.create
  // -----------------------------------------------------------------------

  describe('agent.create', () => {
    it('workspace agent → both A and B receive agent.created', async () => {
      const a = await server.createClient()
      const b = await server.createClient()
      try {
        await a.authenticate(userAEmail)
        await b.authenticate(userBEmail)

        const aBroadcast = waitForBroadcast(a, 'agent.created')
        const bBroadcast = waitForBroadcast(b, 'agent.created')

        const data = await sendAndWaitForResponse(a, 'agent.create', {
          name: 'Bot',
          fullName: 'Bot Bot',
          role: 'tester',
          intro: 'Hi',
          workspaceId,
        })
        expect(data.agent.agentId).toBeTruthy()

        const [aEvent, bEvent] = await Promise.all([aBroadcast, bBroadcast])
        expect(aEvent.agent.agentId).toBe(data.agent.agentId)
        expect(aEvent.agent.workspaceId).toBe(workspaceId)
        expect(bEvent.agent.agentId).toBe(data.agent.agentId)
      } finally {
        a.close()
        b.close()
      }
    })

    it('global agent (no workspaceId) → only A receives, B does not', async () => {
      const a = await server.createClient()
      const b = await server.createClient()
      try {
        await a.authenticate(userAEmail)
        await b.authenticate(userBEmail)

        const aBroadcast = waitForBroadcast(a, 'agent.created')

        const data = await sendAndWaitForResponse(a, 'agent.create', {
          name: 'Bot',
          fullName: 'Bot Bot',
          role: 'tester',
          intro: 'Hi',
        })
        const aEvent = await aBroadcast
        expect(aEvent.agent.agentId).toBe(data.agent.agentId)
        expect(aEvent.agent.workspaceId).toBeUndefined()

        // B should NOT receive an agent.created within the timeout.
        await expect(waitForBroadcast(b, 'agent.created', 600)).rejects.toThrow(/Timeout/)
      } finally {
        a.close()
        b.close()
      }
    })
  })

  // -----------------------------------------------------------------------
  // agent.delete (workspace fan-out using the captured workspaceId)
  // -----------------------------------------------------------------------

  describe('agent.delete', () => {
    it('workspace agent delete → both A and B receive agent.deleted with workspaceId', async () => {
      const a = await server.createClient()
      const b = await server.createClient()
      try {
        await a.authenticate(userAEmail)
        await b.authenticate(userBEmail)

        // Drain the agent.created event from setup so it doesn't leak into deleted match
        const created = await sendAndWaitForResponse(a, 'agent.create', {
          name: 'Bot',
          fullName: 'Bot Bot',
          role: 'tester',
          intro: 'Hi',
          workspaceId,
        })
        await Promise.all([
          waitForBroadcast(a, 'agent.created'),
          waitForBroadcast(b, 'agent.created'),
        ])

        const aDeleted = waitForBroadcast(a, 'agent.deleted')
        const bDeleted = waitForBroadcast(b, 'agent.deleted')

        await sendAndWaitForResponse(a, 'agent.delete', { agentId: created.agent.agentId })

        const [aEvent, bEvent] = await Promise.all([aDeleted, bDeleted])
        expect(aEvent.agentId).toBe(created.agent.agentId)
        expect(aEvent.workspaceId).toBe(workspaceId)
        expect(bEvent.agentId).toBe(created.agent.agentId)
      } finally {
        a.close()
        b.close()
      }
    })
  })

  // -----------------------------------------------------------------------
  // workspace.update — workspace fan-out
  // -----------------------------------------------------------------------

  describe('workspace.update', () => {
    it('rename → both A and B receive workspace.updated', async () => {
      const a = await server.createClient()
      const b = await server.createClient()
      try {
        await a.authenticate(userAEmail)
        await b.authenticate(userBEmail)

        const aUpdated = waitForBroadcast(a, 'workspace.updated')
        const bUpdated = waitForBroadcast(b, 'workspace.updated')

        await sendAndWaitForResponse(a, 'workspace.update', {
          workspaceId,
          name: 'Renamed W',
        })

        const [aEvent, bEvent] = await Promise.all([aUpdated, bUpdated])
        expect(aEvent.workspace.workspaceId).toBe(workspaceId)
        expect(aEvent.workspace.name).toBe('Renamed W')
        expect(bEvent.workspace.name).toBe('Renamed W')
      } finally {
        a.close()
        b.close()
      }
    })
  })

  // -----------------------------------------------------------------------
  // workspace.archive — captured-before-archive fan-out
  // -----------------------------------------------------------------------

  describe('workspace.archive', () => {
    it('archive → both A and B receive workspace.archived', async () => {
      const a = await server.createClient()
      const b = await server.createClient()
      try {
        await a.authenticate(userAEmail)
        await b.authenticate(userBEmail)

        const aArchived = waitForBroadcast(a, 'workspace.archived')
        const bArchived = waitForBroadcast(b, 'workspace.archived')

        await sendAndWaitForResponse(a, 'workspace.archive', { workspaceId })

        const [aEvent, bEvent] = await Promise.all([aArchived, bArchived])
        expect(aEvent.workspaceId).toBe(workspaceId)
        expect(bEvent.workspaceId).toBe(workspaceId)
      } finally {
        a.close()
        b.close()
      }
    })
  })

  // -----------------------------------------------------------------------
  // project.created / project.deleted — workspace fan-out
  // -----------------------------------------------------------------------

  describe('board.create-project / delete-project', () => {
    it('create then delete → both A and B receive project.created and project.deleted', async () => {
      const a = await server.createClient()
      const b = await server.createClient()
      try {
        await a.authenticate(userAEmail)
        await b.authenticate(userBEmail)

        const aCreated = waitForBroadcast(a, 'project.created')
        const bCreated = waitForBroadcast(b, 'project.created')

        const created = await sendAndWaitForResponse(a, 'board.create-project', {
          workspaceId,
          name: 'P1',
        })

        const [aCreEvt, bCreEvt] = await Promise.all([aCreated, bCreated])
        expect(aCreEvt.project.projectId).toBe(created.project.projectId)
        expect(aCreEvt.project.workspaceId).toBe(workspaceId)
        expect(bCreEvt.project.projectId).toBe(created.project.projectId)

        const aDeleted = waitForBroadcast(a, 'project.deleted')
        const bDeleted = waitForBroadcast(b, 'project.deleted')

        await sendAndWaitForResponse(a, 'board.delete-project', {
          projectId: created.project.projectId,
        })

        const [aDelEvt, bDelEvt] = await Promise.all([aDeleted, bDeleted])
        expect(aDelEvt.projectId).toBe(created.project.projectId)
        expect(aDelEvt.workspaceId).toBe(workspaceId)
        expect(bDelEvt.projectId).toBe(created.project.projectId)
      } finally {
        a.close()
        b.close()
      }
    })
  })

  // -----------------------------------------------------------------------
  // app.install — owner workspace fan-out (private workspace = solo A)
  // -----------------------------------------------------------------------

  describe('app.install', () => {
    it('install in A private workspace → only A receives, B does not', async () => {
      const a = await server.createClient()
      const b = await server.createClient()
      try {
        await a.authenticate(userAEmail)
        await b.authenticate(userBEmail)

        const aInstalled = waitForBroadcast(a, 'app.installed')

        const data = await sendAndWaitForResponse(a, 'app.install', {
          mcaId: TEST_MCA_ID,
        })
        const aEvent = await aInstalled
        expect(aEvent.app.appId).toBe(data.app.appId)
        expect(aEvent.app.mcaId).toBe(TEST_MCA_ID)
        expect(aEvent.app.mcaName).toBe('Test Fixture')

        await expect(waitForBroadcast(b, 'app.installed', 600)).rejects.toThrow(/Timeout/)
      } finally {
        a.close()
        b.close()
      }
    })
  })

  // -----------------------------------------------------------------------
  // app.rename — owner workspace fan-out
  // -----------------------------------------------------------------------

  describe('app.rename', () => {
    it('rename in A private workspace → A receives app.updated', async () => {
      const a = await server.createClient()
      try {
        await a.authenticate(userAEmail)

        // Use a multi-install MCA so renaming after install works (we already
        // installed one in app.install test; reuse server state by installing
        // a fresh one here under a unique name).
        const installed = await sendAndWaitForResponse(a, 'app.install', {
          mcaId: TEST_MCA_ID,
        })
        await waitForBroadcast(a, 'app.installed')

        const aUpdated = waitForBroadcast(a, 'app.updated')
        await sendAndWaitForResponse(a, 'app.rename', {
          appId: installed.app.appId,
          name: 'renamed-fixture',
        })

        const event = await aUpdated
        expect(event.app.appId).toBe(installed.app.appId)
        expect(event.app.name).toBe('renamed-fixture')
        expect(event.app.mcaName).toBe('Test Fixture')
      } finally {
        a.close()
      }
    })
  })

  // -----------------------------------------------------------------------
  // workspace.install-app — workspace fan-out (shared W)
  // -----------------------------------------------------------------------

  describe('workspace.install-app', () => {
    it('install in shared workspace → both A and B receive app.installed', async () => {
      const a = await server.createClient()
      const b = await server.createClient()
      try {
        await a.authenticate(userAEmail)
        await b.authenticate(userBEmail)

        const aInstalled = waitForBroadcast(a, 'app.installed')
        const bInstalled = waitForBroadcast(b, 'app.installed')

        const data = await sendAndWaitForResponse(a, 'workspace.install-app', {
          workspaceId,
          mcaId: TEST_MCA_ID,
          name: 'shared-app',
        })

        const [aEvent, bEvent] = await Promise.all([aInstalled, bInstalled])
        expect(aEvent.app.appId).toBe(data.app.appId)
        expect(aEvent.app.mcaName).toBe('Test Fixture')
        expect(bEvent.app.appId).toBe(data.app.appId)
      } finally {
        a.close()
        b.close()
      }
    })
  })

  // -----------------------------------------------------------------------
  // Negative scope — outsider C never receives workspace events
  // -----------------------------------------------------------------------

  describe('negative scope', () => {
    it('outsider client does not receive workspace.updated for W', async () => {
      const a = await server.createClient()
      const c = await server.createClient()
      try {
        await a.authenticate(userAEmail)
        await c.authenticate(userCEmail)

        await sendAndWaitForResponse(a, 'workspace.update', {
          workspaceId,
          name: 'W-changed-again',
        })

        await expect(waitForBroadcast(c, 'workspace.updated', 600)).rejects.toThrow(/Timeout/)
      } finally {
        a.close()
        c.close()
      }
    })
  })

  // -----------------------------------------------------------------------
  // agent.update — workspace fan-out, enriched agent payload (TER-449)
  // -----------------------------------------------------------------------

  describe('agent.update', () => {
    it('update → both A and B receive agent.updated with the full enriched agent', async () => {
      const a = await server.createClient()
      const b = await server.createClient()
      try {
        await a.authenticate(userAEmail)
        await b.authenticate(userBEmail)

        const created = await sendAndWaitForResponse(a, 'agent.create', {
          coreId: 'core:test',
          name: 'Bot',
          fullName: 'Bot Bot',
          role: 'tester',
          intro: 'Hi',
          avatarUrl: 'https://example.com/bot.png',
          workspaceId,
        })
        await Promise.all([
          waitForBroadcast(a, 'agent.created'),
          waitForBroadcast(b, 'agent.created'),
        ])

        const aUpdated = waitForBroadcast(a, 'agent.updated')
        const bUpdated = waitForBroadcast(b, 'agent.updated')
        await sendAndWaitForResponse(a, 'agent.update', {
          agentId: created.agent.agentId,
          name: 'Bot 2',
          maxSteps: 7,
        })

        const [aEvent, bEvent] = await Promise.all([aUpdated, bUpdated])
        // Both members get the event, scoped to the workspace.
        expect(bEvent.agent.agentId).toBe(created.agent.agentId)
        // Enriched shape: the navbar-relevant identity fields are all present,
        // not just the id — a partial payload would null them on upsert.
        for (const field of ['agentId', 'name', 'fullName', 'role', 'avatarUrl', 'coreId', 'workspaceId']) {
          expect(aEvent.agent).toHaveProperty(field)
        }
        expect(aEvent.agent.name).toBe('Bot 2')
        expect(aEvent.agent.workspaceId).toBe(workspaceId)
        expect(aEvent.agent.maxSteps).toBe(7)
      } finally {
        a.close()
        b.close()
      }
    })
  })

  // -----------------------------------------------------------------------
  // app.uninstall — owner workspace fan-out (TER-449)
  // -----------------------------------------------------------------------

  describe('app.uninstall', () => {
    it('uninstall in A private workspace → A receives app.uninstalled with appId', async () => {
      const a = await server.createClient()
      const b = await server.createClient()
      try {
        await a.authenticate(userAEmail)
        await b.authenticate(userBEmail)

        const installed = await sendAndWaitForResponse(a, 'app.install', { mcaId: TEST_MCA_ID })
        await waitForBroadcast(a, 'app.installed')

        const aUninstalled = waitForBroadcast(a, 'app.uninstalled')
        await sendAndWaitForResponse(a, 'app.uninstall', { appId: installed.app.appId })

        const aEvent = await aUninstalled
        expect(aEvent.appId).toBe(installed.app.appId)
        expect(aEvent.ownerId).toBeTruthy()

        // Private-workspace app → unrelated member B does not receive it.
        await expect(waitForBroadcast(b, 'app.uninstalled', 600)).rejects.toThrow(/Timeout/)
      } finally {
        a.close()
        b.close()
      }
    })
  })

  // -----------------------------------------------------------------------
  // workspace.create — user-scoped broadcast (only the creator) (TER-449)
  // -----------------------------------------------------------------------

  describe('workspace.create', () => {
    it('create → only the creator A receives workspace.created; B does not', async () => {
      const a = await server.createClient()
      const b = await server.createClient()
      try {
        await a.authenticate(userAEmail)
        await b.authenticate(userBEmail)

        const aCreated = waitForBroadcast(a, 'workspace.created')
        const data = await sendAndWaitForResponse(a, 'workspace.create', {
          name: 'Fresh WS',
          type: 'shared',
        })

        const aEvent = await aCreated
        expect(aEvent.workspace.workspaceId).toBe(data.workspace.workspaceId)
        expect(aEvent.workspace.name).toBe('Fresh WS')
        expect(aEvent.workspace.role).toBe('owner')

        // user-scoped broadcast → B (not yet a member) must not receive it.
        await expect(waitForBroadcast(b, 'workspace.created', 600)).rejects.toThrow(/Timeout/)
      } finally {
        a.close()
        b.close()
      }
    })
  })

  // -----------------------------------------------------------------------
  // board.update-project — workspace fan-out, enriched project (TER-449)
  // -----------------------------------------------------------------------

  describe('board.update-project', () => {
    it('update → both A and B receive project.updated with the enriched project', async () => {
      const a = await server.createClient()
      const b = await server.createClient()
      try {
        await a.authenticate(userAEmail)
        await b.authenticate(userBEmail)

        const created = await sendAndWaitForResponse(a, 'board.create-project', {
          workspaceId,
          name: 'Proj',
        })
        await Promise.all([
          waitForBroadcast(a, 'project.created'),
          waitForBroadcast(b, 'project.created'),
        ])

        const aUpdated = waitForBroadcast(a, 'project.updated')
        const bUpdated = waitForBroadcast(b, 'project.updated')
        await sendAndWaitForResponse(a, 'board.update-project', {
          projectId: created.project.projectId,
          name: 'Proj 2',
        })

        const [aEvent, bEvent] = await Promise.all([aUpdated, bUpdated])
        expect(aEvent.project.projectId).toBe(created.project.projectId)
        expect(aEvent.project.workspaceId).toBe(workspaceId)
        expect(aEvent.project.name).toBe('Proj 2')
        expect(bEvent.project.projectId).toBe(created.project.projectId)
      } finally {
        a.close()
        b.close()
      }
    })
  })
})
