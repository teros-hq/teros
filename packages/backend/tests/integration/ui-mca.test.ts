/**
 * Integration test — mca.teros.ui E2E over the real ui.* domain
 * (spec 20261022_ui-state-mca.md REQ-5; terminal-mca.test.ts pattern).
 *
 * Full wiring, no fakes of the stack:
 *
 *   MCA process (bun, HTTP transport)
 *     ├─ WS /mca?appId&token → McaConnectionManager (TestServer bridge)
 *     │    └─ admin_request ui.* → WsRouter → ui domain → UiStateManager + PubSub
 *     └─ HTTP /tools/call ← McaHttpClient (this test, as the backend does)
 *
 * Two authenticated WS clients play the user's two devices (web + mobile):
 * they ui.report their state and receive ui_command events. Covers the
 * MCA-side acceptance criteria:
 *
 *   1. ui-state returns both devices with enrichment (AC-1).
 *   2. ui-open broadcast reaches BOTH devices (delivered: 2, ui_command on
 *      each client — AC-3, AC-10).
 *   3. ui-set-desktop (frontend action, default 'active') reaches ONLY the
 *      most recently active device (AC-4).
 *   4. ui-update-props broadcast merges props on both devices (AC-5).
 *   5. delivered: 0 with no reporting client is explicit in the tool output
 *      (AC-6).
 *   6. Authz passthrough: backend error codes surface as tool errors.
 *
 * No Docker needed: the ui domain is pure in-memory + pubsub.
 * SKIP in CI (MCA process spawn — same criterion as terminal-mca).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { McaHttpClient } from '../../src/services/mca-http-client'
import { PtyManager } from '../../src/services/pty-manager'
import {
  createTestServer,
  type TestServerInstance,
  type TestWebSocketClient,
} from '@teros/testing'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MCA_PORT = 14_000 + Math.floor(Math.random() * 900)
const MCA_URL = `http://127.0.0.1:${MCA_PORT}`
const MCA_ENTRY = new URL('../../../../mcas/mca.teros.ui/src/index.ts', import.meta.url).pathname

const OWNER_EMAIL = 'owner@ui-mca.test'
// MockAuthHandler: email → user:test_<localPart>
const OWNER_ID = 'user:test_owner'
const WORKSPACE_ID = 'work_uimca_test'
const UI_APP_ID = 'app_uimca000000001'

const EXEC_CONTEXT = {
  userId: OWNER_ID,
  workspaceId: WORKSPACE_ID,
  appId: UI_APP_ID,
} as const

const SKIP_IN_CI = process.env.CI === 'true' || process.env.SKIP_MCA_INTEGRATION === 'true'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let server: TestServerInstance
let webClient: TestWebSocketClient
let mobileClient: TestWebSocketClient
let mcaProcess: ReturnType<typeof Bun.spawn> | null = null
let mcaHttp: McaHttpClient

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

/** MCA tool call (the test plays the backend: McaHttpClient → /tools/call). */
async function callTool(tool: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await mcaHttp.callTool(tool, args, EXEC_CONTEXT as any, { timeout: 30_000 })
  if (!result.success) {
    const err: any = new Error(
      `tool ${tool} failed: ${JSON.stringify(result.error ?? result)}` +
        ` [mca exitCode=${mcaProcess?.exitCode ?? 'alive'}]`,
    )
    err.detail = result.error
    throw err
  }
  const r: any = result.result
  if (r && typeof r === 'object' && Array.isArray(r.content)) {
    const text = r.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return r
}

/** In-memory buffer of the MCA process output (dumped on failure/afterAll). */
const processLog: string[] = []

/** A well-formed ui.report for `deviceId`. */
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
        props: { channelId: 'ch_mca_1', agentId: 'agent_mca_alice' },
      },
      w_board: { windowId: 'w_board', type: 'board', props: { projectId: 'proj_mca_1' } },
    },
    focusedWindowId,
    windowTypes: [
      { type: 'chat', displayName: 'Chat' },
      { type: 'board', displayName: 'Board' },
      { type: 'terminal', displayName: 'Terminal' },
    ],
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('mca.teros.ui E2E (real MCA process + bridge WS + real ui domain)', () => {
  beforeAll(async () => {
    if (SKIP_IN_CI) {
      console.log('[ui-mca] Skipping in CI')
      return
    }

    // The terminal domain registers unconditionally and dereferences
    // ptyManager.onChange — a real PtyManager must be injected or
    // createTestServer crashes (ui-state.test.ts / terminal-mca.test.ts pattern).
    const ptyManager = new PtyManager({
      broadcastToTopic: () => {},
    } as any)

    server = await createTestServer({
      enableNavbarStack: true,
      enableMcaBridge: true,
      ptyManager,
      mockResponses: [{ text: 'mock' }],
    })

    // ── Seed: workspace + owner + app + catalog entry (terminal-mca pattern)
    const { db } = server
    await db.collection('workspaces').insertOne({
      workspaceId: WORKSPACE_ID,
      ownerId: OWNER_ID,
      name: 'UI MCA Test Workspace',
      status: 'active',
      members: [{ userId: OWNER_ID, role: 'admin', addedAt: new Date() }],
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await db.collection('workspace_members').insertOne({
      workspaceId: WORKSPACE_ID,
      userId: OWNER_ID,
      role: 'admin',
      status: 'active',
    })
    await db.collection('users').insertOne({
      userId: OWNER_ID,
      email: OWNER_EMAIL,
      accessGranted: true,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    // Enrichment sources for ui-state (chat agent + channel, board project)
    await db.collection('agents').insertOne({
      agentId: 'agent_mca_alice',
      name: 'Alice Evergreen',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await db.collection('channels').insertOne({
      channelId: 'ch_mca_1',
      metadata: { name: 'Design review' },
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await db.collection('projects').insertOne({
      projectId: 'proj_mca_1',
      name: 'Platform Development',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await db.collection('apps').insertOne({
      appId: UI_APP_ID,
      mcaId: 'mca.teros.ui',
      ownerId: WORKSPACE_ID,
      ownerType: 'workspace',
      name: 'ui-control',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    // admin_request only lets through the manifest's backend.actions
    // (synced to mca_catalog by sync-mcas; the TestServer does not sync).
    await db.collection('mca_catalog').insertOne({
      mcaId: 'mca.teros.ui',
      backendActions: ['ui.*'],
    })

    // ── Spawn the real MCA process (HTTP transport + WS bridge)
    const token = server.mcaConnectionManager!.registerPendingConnection(
      UI_APP_ID,
      'mca.teros.ui',
      WORKSPACE_ID,
    )
    const wsUrl = `ws://127.0.0.1:${server.port}/mca?appId=${UI_APP_ID}&token=${token}`
    mcaProcess = Bun.spawn(['bun', 'run', MCA_ENTRY], {
      env: {
        ...process.env,
        PORT: String(MCA_PORT),
        MCA_WS_URL: wsUrl,
        MCA_APP_ID: UI_APP_ID,
        MCA_REQUIRE_SIGNATURE: 'false',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    // Drain pipes into an in-memory buffer (a full pipe blocks the MCA
    // process; the buffer is dumped in afterAll / on failure — no truncation)
    const drain = async (stream: ReadableStream<Uint8Array> | undefined) => {
      if (!stream) return
      const reader = stream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) processLog.push(new TextDecoder().decode(value))
        }
      } catch {
        /* process ended */
      }
    }
    void drain(mcaProcess.stdout)
    void drain(mcaProcess.stderr)

    // Wait for the MCA's /health
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${MCA_URL}/health`)
        if (res.ok) break
      } catch {
        /* not ready yet */
      }
      await sleep(200)
    }

    mcaHttp = new McaHttpClient({ baseUrl: MCA_URL })

    // ── Two "devices" of the user: web + mobile (authenticated WS clients)
    webClient = await server.createClient()
    await webClient.authenticate(OWNER_EMAIL)
    mobileClient = await server.createClient()
    await mobileClient.authenticate(OWNER_EMAIL)
  }, 60_000)

  afterAll(async () => {
    // Give the drain a beat to capture the exit output, then dump the MCA
    // process log — the only way to see why it died when it dies.
    await sleep(300)
    if (processLog.length > 0) {
      console.log('===== MCA process log =====')
      console.log(processLog.join(''))
      console.log('===== end MCA process log =====')
    }
    mcaProcess?.kill()
    webClient?.close()
    mobileClient?.close()
    await server?.close()
  })

  // =========================================================================
  // AC-1 — read what the user sees (both devices, enriched)
  // =========================================================================

  it('ui-state: both devices report, enrichment resolved, catalog returned', async () => {
    if (SKIP_IN_CI) return

    // Force the WS connection (the MCA connects lazily on first backendAction)
    const deadline = Date.now() + 15_000
    let ready = false
    while (Date.now() < deadline) {
      try {
        await callTool('ui-state')
        ready = true
        break
      } catch {
        /* MCA starting or WS not connected yet */
      }
      await sleep(300)
    }
    expect(ready).toBe(true)

    // No device has reported yet → empty, explicit
    let state = await callTool('ui-state')
    expect(state.onlineCount).toBe(0)
    expect(state.note).toContain('no connected client')

    // Both devices report (mobile last → most recently active)
    await request(webClient, 'ui.report', uiReport('dev_web', 'Web · Chrome', 'w_chat'))
    await request(mobileClient, 'ui.report', uiReport('dev_iphone', 'iPhone', 'w_board'))

    state = await callTool('ui-state')
    expect(state.onlineCount).toBe(2)
    expect(state.devices.length).toBe(2)
    const web = state.devices.find((d: any) => d.deviceId === 'dev_web')
    expect(web.deviceLabel).toBe('Web · Chrome')
    expect(web.focusedWindowId).toBe('w_chat')
    // AC-1 enrichment: chat → agentName + channelTitle; board → projectName
    expect(web.windows.w_chat.enrichment.agentName).toBe('Alice Evergreen')
    expect(web.windows.w_chat.enrichment.channelTitle).toBe('Design review')
    expect(web.windows.w_board.enrichment.projectName).toBe('Platform Development')
    // Dynamic catalog surfaced
    expect(state.windowTypes.map((t: any) => t.type)).toContain('terminal')
  }, 20_000)

  // =========================================================================
  // AC-3 / AC-10 — broadcast open-window reaches BOTH devices
  // =========================================================================

  it('ui-open: broadcast (default target) → delivered 2, ui_command on both clients', async () => {
    if (SKIP_IN_CI) return

    // Arm both clients to catch their next ui_command
    const webPromise = webClient.waitFor((m: any) => m.type === 'ui_command', 10_000)
    const mobilePromise = mobileClient.waitFor((m: any) => m.type === 'ui_command', 10_000)

    const out = await callTool('ui-open', {
      windowType: 'chat',
      props: { agentId: 'agent_mca_alice' },
    })

    expect(out.command).toBe('open-window')
    expect(out.delivered).toBe(2)
    expect(out.applied).toBe(true)
    expect(out.outcome).toContain('every connected device')

    const [webMsg, mobileMsg] = await Promise.all([webPromise, mobilePromise])
    for (const msg of [webMsg, mobileMsg]) {
      expect(msg.command.command).toBe('open-window')
      expect(msg.command.windowType).toBe('chat')
      expect(msg.command.props).toEqual({ agentId: 'agent_mca_alice' })
      expect(msg.command.focus).toBe(true) // Q8: focus everywhere
      expect(msg.command.commandId).toBeTruthy()
    }
  }, 20_000)

  // =========================================================================
  // AC-4 — frontend action targets only the active device
  // =========================================================================

  it('ui-set-desktop: default target active → only the most recently active device', async () => {
    if (SKIP_IN_CI) return

    // mobileClient reported last → it is the active device.
    // NOTE: the "web got nothing" wait must stay well under the test timeout —
    // bun's default is 5s and a timed-out test makes bun kill the spawned MCA
    // ("killed 1 dangling process"), cascading CONNECTION_FAILED into every
    // later test. Hence 1.5s here + an explicit 20s test timeout below.
    const webPromise = webClient.waitFor((m: any) => m.type === 'ui_command', 1_500).catch(() => null)
    const mobilePromise = mobileClient.waitFor((m: any) => m.type === 'ui_command', 10_000)

    const out = await callTool('ui-set-desktop', { desktopId: 'd2' })

    expect(out.command).toBe('set-active-desktop')
    expect(out.delivered).toBe(1)
    expect(out.target).toBe('dev_iphone')

    const mobileMsg = await mobilePromise
    expect(mobileMsg.command.command).toBe('set-active-desktop')
    expect(mobileMsg.command.desktopId).toBe('d2')

    // The web device got nothing (timeout → null)
    const webMsg = await webPromise
    expect(webMsg).toBeNull()
  }, 20_000)

  // =========================================================================
  // AC-5 — update-window-props broadcast
  // =========================================================================

  it('ui-update-props: broadcast merge on both devices', async () => {
    if (SKIP_IN_CI) return

    const webPromise = webClient.waitFor((m: any) => m.type === 'ui_command', 10_000)
    const mobilePromise = mobileClient.waitFor((m: any) => m.type === 'ui_command', 10_000)

    const out = await callTool('ui-update-props', {
      windowId: 'w_board',
      props: { projectId: 'proj_mca_2' },
    })

    expect(out.command).toBe('update-window-props')
    expect(out.delivered).toBe(2)

    const [webMsg, mobileMsg] = await Promise.all([webPromise, mobilePromise])
    expect(webMsg.command.props).toEqual({ projectId: 'proj_mca_2' })
    expect(mobileMsg.command.props).toEqual({ projectId: 'proj_mca_2' })
  }, 20_000)

  // =========================================================================
  // AC-6 — offline is explicit (delivered: 0 phrasing)
  // =========================================================================

  it('ui-open with no reporting session in a fresh workspace → delivered 0, explicit outcome', async () => {
    if (SKIP_IN_CI) return

    // A second workspace where the user has NO reporting client. The app's
    // owner is the workspace owner (admin_request resolves it), so authz
    // passes; delivery finds no session subscribed → delivered: 0.
    const { db } = server
    const WS2 = 'work_uimca_empty'
    await db.collection('workspaces').insertOne({
      workspaceId: WS2,
      ownerId: OWNER_ID,
      name: 'Empty WS',
      status: 'active',
      members: [{ userId: OWNER_ID, role: 'admin', addedAt: new Date() }],
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await db.collection('workspace_members').insertOne({
      workspaceId: WS2,
      userId: OWNER_ID,
      role: 'admin',
      status: 'active',
    })

    const out = await mcaHttp.callTool(
      'ui-open',
      { windowType: 'chat', props: { agentId: 'agent_mca_alice' } },
      { ...EXEC_CONTEXT, workspaceId: WS2 } as any,
      { timeout: 30_000 },
    )
    expect(out.success).toBe(true)
    // HTTP envelope: the handler's return value IS `out.result` (the SDK puts
    // plain-object returns there directly — no MCP content array).
    const parsed = out.result as any
    expect(parsed.delivered).toBe(0)
    expect(parsed.applied).toBe(false)
    expect(parsed.outcome).toContain('NOTHING HAPPENED')
    expect(parsed.outcome).toContain('no connected client')
  }, 20_000)

  // =========================================================================
  // Errors surface as tool errors
  // =========================================================================

  it('unknown deviceId target → UI_UNKNOWN_DEVICE surfaces as a tool error', async () => {
    if (SKIP_IN_CI) return

    try {
      await callTool('ui-focus', { windowId: 'w_chat', target: 'dev_nope' })
      throw new Error('expected ui-focus to fail')
    } catch (err: any) {
      expect(err.message).toContain('UI_UNKNOWN_DEVICE')
    }
  }, 20_000)

  it('health check reports ready once the bridge is connected', async () => {
    if (SKIP_IN_CI) return
    const health = await callTool('-health-check')
    expect(health.status).toBe('ready')
  }, 20_000)
})
