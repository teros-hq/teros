/**
 * Integration test — ui.* domain over a real TestServer
 * (spec 20261022_ui-state-mca.md REQ-2/3/4; terminal-mca.test.ts pattern).
 *
 * Full wiring, no fakes of the stack: authenticated WS clients →
 * WebSocketHandler → WsRouter → ui domain → UiStateManager + PubSubService +
 * real MongoDB (ephemeral DB per run). Covers:
 *
 *   1. report → get-state round trip with read-time enrichment
 *      (chat → agentName/channelTitle; board → projectName) — AC-1.
 *   2. Authz: a read-role member may report its own state but gets
 *      FORBIDDEN_WORKSPACE_ROLE on get-state AND command (AC-8).
 *   3. Command delivery: broadcast open-window reaches BOTH devices'
 *      sessions (delivered: 2, ui_command received on each client — AC-3);
 *      a frontend action (set-active-desktop, default 'active') reaches only
 *      the most recently active device (AC-4).
 *   4. UI_UNKNOWN_DEVICE lists the online devices.
 *   5. UI_BAD_REPORT keeps the previous state.
 *
 * No MCA process needed: ui.command is called by the owner's own session —
 * the same authz path the admin_request bridge exercises (the bridge resolves
 * the app owner's userId and dispatches through the same WsRouter; the
 * bridge-specific paths are unit-tested in ui-handlers.test.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  createTestServer,
  type TestServerInstance,
  type TestWebSocketClient,
} from '@teros/testing'
import { PtyManager } from '../../src/services/pty-manager'

const OWNER_EMAIL = 'owner@ui.test'
const READER_EMAIL = 'reader@ui.test'
// MockAuthHandler: email → user:test_<localPart>
const OWNER_ID = 'user:test_owner'
const READER_ID = 'user:test_reader'
const WORKSPACE_ID = 'work_ui_it'

let server: TestServerInstance
let ownerA: TestWebSocketClient
let ownerB: TestWebSocketClient
let reader: TestWebSocketClient

let seq = 0
/** WsRequest via the framework protocol; resolves the response data or throws {code}. */
async function request<T = any>(
  client: TestWebSocketClient,
  action: string,
  data: any,
): Promise<T> {
  const requestId = `req_${++seq}`
  client.send({ type: 'request', requestId, action, data })
  const msg = await client.waitFor(
    (m: any) => (m.type === 'response' || m.type === 'error') && m.requestId === requestId,
    10_000,
  )
  if (msg.type === 'error') {
    const err: any = new Error(msg.message)
    err.code = msg.code
    throw err
  }
  return msg.data as T
}

/** A well-formed report for `deviceId` (two windows: chat + board). */
function uiReport(deviceId: string, deviceLabel: string, focusedWindowId: string) {
  return {
    workspaceId: WORKSPACE_ID,
    deviceId,
    deviceLabel,
    desktops: [
      {
        desktopId: 'd1',
        name: 'Desktop 1',
        layout: {
          kind: 'split',
          direction: 'horizontal',
          ratio: 0.6,
          children: [
            { kind: 'container', windowIds: ['w_chat'], activeWindowId: 'w_chat' },
            { kind: 'container', windowIds: ['w_board'], activeWindowId: 'w_board' },
          ],
        },
      },
      { desktopId: 'd2', name: 'Desktop 2', layout: null },
    ],
    activeDesktopId: 'd1',
    windows: {
      w_chat: {
        windowId: 'w_chat',
        type: 'chat',
        props: { channelId: 'ch_it_1', agentId: 'agent_it_alice' },
      },
      w_board: { windowId: 'w_board', type: 'board', props: { projectId: 'proj_it_1' } },
    },
    focusedWindowId,
    windowTypes: [
      { type: 'chat', displayName: 'Chat' },
      { type: 'board', displayName: 'Board' },
    ],
  }
}

beforeAll(async () => {
  // The terminal domain registers unconditionally and dereferences
  // ptyManager.onChange — a real PtyManager must be injected or
  // createTestServer crashes (terminal-mca.test.ts pattern).
  const ptyManager = new PtyManager({
    broadcastToTopic: () => {},
  } as any)
  server = await createTestServer({ enableNavbarStack: true, ptyManager })

  // Fixtures (terminal-mca.test.ts pattern): users + workspace + members + enrichment docs.
  // users with accessGranted are REQUIRED — hasAccess() gates every WsRequest
  // dispatch and defaults to false without a user doc (silent ACCESS_DENIED).
  await server.db.collection('users').insertOne({
    userId: OWNER_ID,
    email: OWNER_EMAIL,
    accessGranted: true,
    createdAt: new Date(),
  })
  await server.db.collection('users').insertOne({
    userId: READER_ID,
    email: READER_EMAIL,
    accessGranted: true,
    createdAt: new Date(),
  })
  await server.db.collection('workspaces').insertOne({
    workspaceId: WORKSPACE_ID,
    ownerId: OWNER_ID,
    status: 'active',
    name: 'UI IT workspace',
    createdAt: new Date(),
  })
  await server.db.collection('workspace_members').insertOne({
    workspaceId: WORKSPACE_ID,
    userId: READER_ID,
    role: 'read',
    status: 'active',
    createdAt: new Date(),
  })
  await server.db.collection('channels').insertOne({
    channelId: 'ch_it_1',
    workspaceId: WORKSPACE_ID,
    metadata: { name: 'Chat con Alice' },
    createdAt: new Date(),
  })
  await server.db.collection('agents').insertOne({
    agentId: 'agent_it_alice',
    name: 'Alice',
    createdAt: new Date(),
  })
  await server.db.collection('projects').insertOne({
    projectId: 'proj_it_1',
    workspaceId: WORKSPACE_ID,
    name: 'Platform Development',
    createdAt: new Date(),
  })

  ownerA = await server.createClient()
  await ownerA.authenticate(OWNER_EMAIL)
  // Same user, second device — devices are per (userId, workspaceId).
  ownerB = await server.createClient()
  await ownerB.authenticate(OWNER_EMAIL)
  reader = await server.createClient()
  await reader.authenticate(READER_EMAIL)
}, 60_000)

afterAll(async () => {
  await server.close()
})

describe('ui.* domain — integration', () => {
  it('report → get-state round trip with enrichment (AC-1)', async () => {
    await request(ownerA, 'ui.report', uiReport('dev_web', 'Web · Chrome', 'w_chat'))
    await request(ownerB, 'ui.report', uiReport('dev_iphone', 'iPhone', 'w_board'))

    const res = await request<{ devices: any[] }>(ownerA, 'ui.get-state', {
      workspaceId: WORKSPACE_ID,
    })
    expect(res.devices).toHaveLength(2)
    // Newest report first: dev_iphone reported last.
    expect(res.devices.map((d) => d.deviceId)).toEqual(['dev_iphone', 'dev_web'])

    for (const device of res.devices) {
      expect(device.online).toBe(true)
      expect(typeof device.lastSeen).toBe('string')
      expect(device.desktops).toHaveLength(2)
      expect(device.activeDesktopId).toBe('d1')
      // Read-time semantic enrichment (REQ-3)
      expect(device.windows.w_chat.enrichment).toEqual({
        agentName: 'Alice',
        channelTitle: 'Chat con Alice',
      })
      expect(device.windows.w_board.enrichment).toEqual({
        projectName: 'Platform Development',
      })
      expect(device.windowTypes.map((t: any) => t.type).sort()).toEqual(['board', 'chat'])
    }
    const web = res.devices.find((d) => d.deviceId === 'dev_web')!
    expect(web.deviceLabel).toBe('Web · Chrome')
    expect(web.focusedWindowId).toBe('w_chat')
    expect(web.desktops[0].layout).toMatchObject({ kind: 'split', ratio: 0.6 })
  })

  it('read-role: FORBIDDEN_WORKSPACE_ROLE on get-state AND command — no partial data (AC-8)', async () => {
    // The reader may report its own state (workspace member)…
    await request(reader, 'ui.report', uiReport('dev_reader', 'Reader phone', 'w_chat'))
    // …but reading the mirror AND commanding it require write access.
    await expect(
      request(reader, 'ui.get-state', { workspaceId: WORKSPACE_ID }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_WORKSPACE_ROLE' })
    await expect(
      request(reader, 'ui.command', {
        workspaceId: WORKSPACE_ID,
        command: 'open-window',
        windowType: 'chat',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_WORKSPACE_ROLE' })
  })

  it('broadcast open-window → delivered: 2, ui_command on both devices (AC-3)', async () => {
    const res = await request<{ delivered: number; target: string }>(ownerA, 'ui.command', {
      workspaceId: WORKSPACE_ID,
      command: 'open-window',
      windowType: 'chat',
      props: { agentId: 'agent_it_alice' },
    })
    expect(res).toEqual({ delivered: 2, target: 'all' })

    // Both live clients receive the ui_command event — same commandId (dedup).
    const [a, b] = await Promise.all([
      ownerA.waitFor((m: any) => m.type === 'ui_command', 5_000),
      ownerB.waitFor((m: any) => m.type === 'ui_command', 5_000),
    ])
    expect(a.command.command).toBe('open-window')
    expect(a.command.commandId).toBe(b.command.commandId)
    expect(a.command.focus).toBe(true)
    expect(a.command.target).toBe('all')
    expect(a.command.props).toEqual({ agentId: 'agent_it_alice' })
  })

  it('frontend action (default active) targets only the most recently active device (AC-4)', async () => {
    // dev_web becomes the active device: it reports last.
    await request(ownerA, 'ui.report', uiReport('dev_web', 'Web · Chrome', 'w_chat'))

    const res = await request<{ delivered: number; target: string }>(ownerA, 'ui.command', {
      workspaceId: WORKSPACE_ID,
      command: 'set-active-desktop',
      desktopId: 'd2',
    })
    expect(res).toEqual({ delivered: 1, target: 'dev_web' })

    const event = await ownerA.waitFor(
      (m: any) => m.type === 'ui_command' && m.command.command === 'set-active-desktop',
      5_000,
    )
    expect(event.deviceId).toBe('dev_web')
    expect(event.command.desktopId).toBe('d2')
    // ownerB (the other device) must NOT have received it: the only ui_command
    // in its queue is the earlier broadcast.
    const stray = ownerB
      .getQueuedMessages()
      .filter((m: any) => m.type === 'ui_command' && m.command.command === 'set-active-desktop')
    expect(stray).toHaveLength(0)
  })

  it('UI_UNKNOWN_DEVICE lists the online devices', async () => {
    const err = await request(ownerA, 'ui.command', {
      workspaceId: WORKSPACE_ID,
      command: 'focus-window',
      windowId: 'w_chat',
      target: 'dev_nope',
    }).catch((e: any) => e)
    expect(err.code).toBe('UI_UNKNOWN_DEVICE')
    expect(err.message).toContain('dev_web')
    expect(err.message).toContain('dev_iphone')
  })

  it('UI_BAD_REPORT keeps the previous state', async () => {
    const before = await request<{ devices: any[] }>(ownerA, 'ui.get-state', {
      workspaceId: WORKSPACE_ID,
    })
    await expect(
      request(ownerA, 'ui.report', {
        ...uiReport('dev_web', 'Web · Chrome', 'w_chat'),
        desktops: [],
      }),
    ).rejects.toMatchObject({ code: 'UI_BAD_REPORT' })
    const after = await request<{ devices: any[] }>(ownerA, 'ui.get-state', {
      workspaceId: WORKSPACE_ID,
    })
    expect(after.devices.map((d: any) => d.deviceId).sort()).toEqual(
      before.devices.map((d: any) => d.deviceId).sort(),
    )
    const web = after.devices.find((d: any) => d.deviceId === 'dev_web')!
    expect(web.focusedWindowId).toBe('w_chat')
  })
})
