/**
 * ui.* domain — unit tests (spec 20261022_ui-state-mca.md REQ-2/3/4).
 *
 * Handlers are inline in the domain: tested via register() with a fake router
 * (terminal-handlers.test.ts pattern). Covers the contract boundary:
 *
 *   - authz: read-role denied on get-state AND command (FORBIDDEN_WORKSPACE_ROLE,
 *     never partial data); write member OK; unknown workspace fails closed;
 *     ui.report needs membership and refuses the MCA bridge.
 *   - report: validation (UI_BAD_REPORT, previous state kept), auto-subscribe
 *     to the command topics, ui_state_changed broadcast.
 *   - get-state: devices + read-time enrichment (chat/terminal/board).
 *   - command: defaults per class, explicit target, UI_UNKNOWN_DEVICE with the
 *     online-device list, delivered counting, commandId uniqueness.
 *   - rate limit (NFR-3): 21st command/min and 6th open/min → UI_RATE_LIMITED.
 */

import { describe, expect, it, mock } from "bun:test"
import type { UiStateReport, WsHandlerContext } from "@teros/shared"
import { register } from "../../src/handlers/domains/ui/index"
import {
  uiCommandsTopic,
  uiDeviceTopic,
  uiStateTopic,
} from "../../src/handlers/domains/ui/index"
import { UiStateManager } from "../../src/services/ui-state-manager"

const WORKSPACE = "work_ui"
const OWNER = "user_owner"
const WRITER = "user_writer"
const READER = "user_reader"
const OUTSIDER = "user_outsider"

const ctx = (userId: string, sessionId = "sess1"): WsHandlerContext =>
  ({ userId, sessionId, ip: "127.0.0.1" }) as any

/** ctx tal como lo construye el bridge MCA (admin_request): userId = owner del workspace, sessionId sintético. */
const bridgeCtx = (userId: string, appId = "app_ui"): WsHandlerContext =>
  ({ userId, sessionId: `mca:${appId}`, ip: "mca:mca.teros.ui" }) as any

/** ctx del domain_request (actor explícito con workspace del MCA). */
const actorCtx = (userId: string, workspaceId: string, appId = "app_ui"): WsHandlerContext =>
  ({
    userId,
    sessionId: "mca:app_ui",
    ip: "mca:mca.teros.ui",
    actor: { kind: "agent", appId, workspaceId },
  }) as any

function makeRouter() {
  const handlers = new Map<string, (ctx: WsHandlerContext, data: unknown) => Promise<any>>()
  const router = {
    register: (action: string, handler: any) => {
      if (handlers.has(action)) throw new Error(`duplicate action ${action}`)
      handlers.set(action, handler)
    },
  } as any
  return { router, handlers }
}

// ── Fakes ────────────────────────────────────────────────────────────────────

/** Mock db fiel a canAccessWorkspace/canWriteWorkspace + los $in del enricher. */
function makeDb(
  opts: {
    ownerByWorkspace?: Record<string, string>
    members?: Array<[string, string] | [string, string, "read" | "write" | "admin"]>
    channels?: Array<{ channelId: string; name?: string }>
    agents?: Array<{ agentId: string; name?: string }>
    projects?: Array<{ projectId: string; name?: string }>
  } = {},
) {
  const workspaces = opts.ownerByWorkspace ?? { [WORKSPACE]: OWNER }
  const members = opts.members ?? []
  const channels = (opts.channels ?? []).map((c) => ({
    channelId: c.channelId,
    metadata: { name: c.name },
  }))
  const agents = opts.agents ?? []
  const projects = opts.projects ?? []

  const matches = (doc: any, filter: any): boolean => {
    for (const [key, value] of Object.entries(filter)) {
      if (value && typeof value === "object" && Array.isArray((value as any).$in)) {
        if (!(value as any).$in.includes(doc[key])) return false
      } else if (doc[key] !== value) return false
    }
    return true
  }

  return {
    collection: (name: string) => ({
      findOne: async (filter: any) => {
        if (name === "workspaces") {
          const ownerId = workspaces[filter.workspaceId]
          return ownerId === undefined ? null : { workspaceId: filter.workspaceId, ownerId, status: "active" }
        }
        if (name === "workspace_members") {
          const m = members.find(([w, u]) => w === filter.workspaceId && u === filter.userId)
          return m ? { workspaceId: m[0], userId: m[1], ...(m[2] ? { role: m[2] } : {}) } : null
        }
        if (name === "channels") return channels.find((c) => matches(c, filter)) ?? null
        if (name === "agents") return agents.find((a) => matches(a, filter)) ?? null
        if (name === "projects") return projects.find((p) => matches(p, filter)) ?? null
        return null
      },
      find: (filter: any) => ({
        project: () => ({
          toArray: async () => {
            if (name === "channels") return channels.filter((c) => matches(c, filter))
            if (name === "agents") return agents.filter((a) => matches(a, filter))
            if (name === "projects") return projects.filter((p) => matches(p, filter))
            return []
          },
        }),
      }),
    }),
  } as any
}

/** PubSub fake: topics + sesiones abiertas, para contar `delivered` de verdad. */
function makePubSub() {
  const topics = new Map<string, Set<string>>()
  const sessions = new Map<string, { ws: { readyState: number; send?: (payload: string) => void } }>()
  const broadcasts: Array<{ topic: string; event: any }> = []
  /** Direct ws.send calls (browser commands bypass broadcastToTopic). */
  const directSends: Array<{ sessionId: string; payload: any }> = []
  const recordSend = (sessionId: string) => (payload: string) => {
    directSends.push({ sessionId, payload: JSON.parse(payload) })
  }
  return {
    broadcasts,
    topics,
    directSends,
    openSession(sessionId: string, opts: { readyState?: number; send?: (payload: string) => void } = {}) {
      sessions.set(sessionId, {
        ws: {
          readyState: opts.readyState ?? 1,
          send: opts.send ?? recordSend(sessionId),
        },
      })
    },
    subscribeSession: mock((sessionId: string, topic: string) => {
      if (!topics.has(topic)) topics.set(topic, new Set())
      topics.get(topic)!.add(sessionId)
    }),
    unsubscribeSession: mock((sessionId: string, topic: string) => {
      topics.get(topic)?.delete(sessionId)
    }),
    broadcastToTopic: mock((topic: string, event: any) => {
      broadcasts.push({ topic, event })
    }),
    getTopicSessions: (topic: string) =>
      [...(topics.get(topic) ?? [])]
        .map((sessionId) => ({ sessionId, s: sessions.get(sessionId) }))
        .filter((x): x is { sessionId: string; s: { ws: { readyState: number; send?: (payload: string) => void } } } => !!x.s)
        .map((x) => ({ sessionId: x.sessionId, ws: x.s.ws }) as any),
    // Contar sesiones abiertas suscritas (lo que el dominio mide como delivered)
    deliveredOn: (topic: string) =>
      [...(topics.get(topic) ?? [])].filter((id) => sessions.get(id)?.ws.readyState === 1).length,
  } as any
}

function makePty(sessions: Record<string, { title?: string; kind?: string }> = {}) {
  return { describe: (terminalId: string) => sessions[terminalId] ?? null } as any
}

function report(overrides: Partial<UiStateReport> = {}): UiStateReport {
  return {
    workspaceId: WORKSPACE,
    deviceId: "dev_web",
    deviceLabel: "Web · Chrome",
    desktops: [
      {
        desktopId: "d1",
        layout: {
          kind: "split",
          direction: "horizontal",
          ratio: 0.6,
          children: [
            { kind: "container", windowIds: ["w_chat"], activeWindowId: "w_chat" },
            { kind: "container", windowIds: ["w_term", "w_board"], activeWindowId: "w_term" },
          ],
        },
      },
    ],
    activeDesktopId: "d1",
    windows: {
      w_chat: {
        windowId: "w_chat",
        type: "chat",
        props: { channelId: "ch_1", agentId: "agent_alice" },
      },
      w_term: { windowId: "w_term", type: "terminal", props: { tabs: ["t_1", "t_2"], active: "t_1" } },
      w_board: { windowId: "w_board", type: "board", props: { projectId: "proj_1" } },
    },
    focusedWindowId: "w_chat",
    windowTypes: [
      { type: "chat", displayName: "Chat" },
      { type: "terminal", displayName: "Terminal" },
      { type: "board", displayName: "Board" },
    ],
    ...overrides,
  }
}

function setup(
  opts: {
    db?: any
    rateLimits?: { commandsPerMinute?: number; opensPerMinute?: number }
    browserCommandTimeoutMs?: number
  } = {},
) {
  const { router, handlers } = makeRouter()
  const pubSubService = makePubSub()
  let clock = 1_000_000
  const now = () => clock
  const advance = (ms: number) => {
    clock += ms
  }
  let idSeq = 0
  const newCommandId = () => `cmd_${++idSeq}`
  const uiStateManager = new UiStateManager({ now, sweepIntervalMs: 0 })
  const ptyManager = makePty({
    t_1: { title: "build", kind: "shell" },
    t_2: { title: "claude", kind: "claude" },
  })
  register(router, {
    db: opts.db ?? makeDb(),
    pubSubService,
    uiStateManager,
    ptyManager,
    rateLimits: opts.rateLimits,
    ...(opts.browserCommandTimeoutMs !== undefined ? { browserCommandTimeoutMs: opts.browserCommandTimeoutMs } : {}),
    now,
    newCommandId,
  })
  return { handlers, pubSubService, uiStateManager, advance, newCommandId }
}

/** db con owner + writer + reader en WORKSPACE. */
const authDb = () =>
  makeDb({
    ownerByWorkspace: { [WORKSPACE]: OWNER },
    members: [
      [WORKSPACE, WRITER, "write"],
      [WORKSPACE, READER, "read"],
    ],
    channels: [{ channelId: "ch_1", name: "Chat con Alice" }],
    agents: [{ agentId: "agent_alice", name: "Alice" }],
    projects: [{ projectId: "proj_1", name: "Platform Development" }],
  })

// ── Registro ─────────────────────────────────────────────────────────────────

describe("ui register", () => {
  it("registra exactamente las 6 actions del dominio", () => {
    // ui.browser-ticket / ui.browser-suggest left with the cloud-browser backend:
    // the Browser MCA streams over mca-stream-relay since 804553c16.
    const { handlers } = setup()
    expect([...handlers.keys()].sort()).toEqual([
      "ui.command",
      "ui.command-result",
      "ui.get-state",
      "ui.report",
      "ui.subscribe",
      "ui.unsubscribe",
    ])
  })
})

// ── ui.report ────────────────────────────────────────────────────────────────

describe("ui.report", () => {
  it("miembro: guarda el report, suscribe a los topics de comandos y broadcastea ui_state_changed", async () => {
    const { handlers, pubSubService } = setup({ db: authDb() })
    pubSubService.openSession("sess1")
    const res = await handlers.get("ui.report")!(ctx(OWNER), report())
    expect(res).toEqual({ ok: true })

    expect(pubSubService.subscribeSession).toHaveBeenCalledWith(
      "sess1",
      uiCommandsTopic(OWNER, WORKSPACE),
    )
    expect(pubSubService.subscribeSession).toHaveBeenCalledWith(
      "sess1",
      uiDeviceTopic(OWNER, WORKSPACE, "dev_web"),
    )
    const state = pubSubService.broadcasts.find((b) => b.topic === uiStateTopic(WORKSPACE))
    expect(state?.event.type).toBe("ui_state_changed")
    expect(state?.event).toMatchObject({ deviceId: "dev_web", userId: OWNER, online: true })
  })

  it("FORBIDDEN_WORKSPACE si el caller no es miembro del workspace del report", async () => {
    const { handlers } = setup({ db: authDb() })
    await expect(handlers.get("ui.report")!(ctx(OUTSIDER), report())).rejects.toMatchObject({
      code: "FORBIDDEN_WORKSPACE",
    })
  })

  it("FORBIDDEN si llega por el bridge MCA — un report sintético envenenaría el mirror del owner", async () => {
    const { handlers } = setup({ db: authDb() })
    await expect(handlers.get("ui.report")!(bridgeCtx(OWNER), report())).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })

  it("UI_BAD_REPORT en malformed/oversized — y el estado anterior se conserva", async () => {
    const { handlers, uiStateManager } = setup({ db: authDb() })
    await handlers.get("ui.report")!(ctx(OWNER), report({ focusedWindowId: "w_chat" }))

    await expect(
      handlers.get("ui.report")!(ctx(OWNER), { ...report(), desktops: [] }),
    ).rejects.toMatchObject({ code: "UI_BAD_REPORT" })
    await expect(handlers.get("ui.report")!(ctx(OWNER), "garbage")).rejects.toMatchObject({
      code: "UI_BAD_REPORT",
    })

    // El report aceptado sigue siendo el estado vigente.
    const devices = uiStateManager.devices(OWNER, WORKSPACE)
    expect(devices).toHaveLength(1)
    expect(devices[0].report.focusedWindowId).toBe("w_chat")
  })
})

// ── ui.get-state — authz (AC-8) ──────────────────────────────────────────────

describe("ui.get-state — authz", () => {
  it("read-role: FORBIDDEN_WORKSPACE_ROLE, sin datos parciales", async () => {
    const { handlers } = setup({ db: authDb() })
    // El reader reporta su propio estado (permitido)…
    await handlers.get("ui.report")!(ctx(READER, "sess_reader"), report({ deviceId: "dev_r" }))
    // …pero leer el mirror exige write.
    await expect(
      handlers.get("ui.get-state")!(ctx(READER, "sess_reader"), { workspaceId: WORKSPACE }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_WORKSPACE_ROLE" })
  })

  it("write member y owner: OK — cada uno ve sus PROPIOS devices", async () => {
    const { handlers } = setup({ db: authDb() })
    await handlers.get("ui.report")!(ctx(OWNER, "sess_owner"), report())
    await handlers
      .get("ui.report")!(ctx(WRITER, "sess_writer"), report({ deviceId: "dev_writer" }))

    const ownerRes = await handlers.get("ui.get-state")!(ctx(OWNER, "sess_owner"), {
      workspaceId: WORKSPACE,
    })
    expect(ownerRes.devices).toHaveLength(1)
    expect(ownerRes.devices[0].deviceId).toBe("dev_web")

    const writerRes = await handlers.get("ui.get-state")!(ctx(WRITER, "sess_writer"), {
      workspaceId: WORKSPACE,
    })
    expect(writerRes.devices).toHaveLength(1)
    expect(writerRes.devices[0].deviceId).toBe("dev_writer")
  })

  it("workspace desconocido: fail-closed (FORBIDDEN_WORKSPACE_ROLE)", async () => {
    const { handlers } = setup({ db: authDb() })
    await expect(
      handlers.get("ui.get-state")!(ctx(OWNER), { workspaceId: "work_nope" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_WORKSPACE_ROLE" })
  })

  it("MISSING_WORKSPACE_ID sin workspaceId explícito ni actor", async () => {
    const { handlers } = setup({ db: authDb() })
    await expect(handlers.get("ui.get-state")!(ctx(OWNER), {})).rejects.toMatchObject({
      code: "MISSING_WORKSPACE_ID",
    })
  })

  it("el bridge (owner resuelto) lee con workspaceId explícito", async () => {
    const { handlers } = setup({ db: authDb() })
    await handlers.get("ui.report")!(ctx(OWNER, "sess_owner"), report())
    const res = await handlers.get("ui.get-state")!(bridgeCtx(OWNER), { workspaceId: WORKSPACE })
    expect(res.devices).toHaveLength(1)
  })
})

// ── ui.get-state — enriquecimiento (REQ-3, AC-1) ─────────────────────────────

describe("ui.get-state — enriquecimiento en read time", () => {
  it("chat → agentName + channelTitle; terminal → sessions con title/kind; board → projectName", async () => {
    const { handlers } = setup({ db: authDb() })
    await handlers.get("ui.report")!(ctx(OWNER, "sess_owner"), report())

    const res = await handlers.get("ui.get-state")!(ctx(OWNER, "sess_owner"), {
      workspaceId: WORKSPACE,
    })
    expect(res.devices).toHaveLength(1)
    const device = res.devices[0]
    expect(device.deviceId).toBe("dev_web")
    expect(device.deviceLabel).toBe("Web · Chrome")
    expect(device.online).toBe(true)
    expect(typeof device.lastSeen).toBe("string")
    expect(device.focusedWindowId).toBe("w_chat")
    expect(device.desktops[0].layout).toMatchObject({ kind: "split", ratio: 0.6 })

    expect(device.windows.w_chat.enrichment).toEqual({
      agentName: "Alice",
      channelTitle: "Chat con Alice",
    })
    expect(device.windows.w_term.enrichment?.sessions).toEqual([
      { terminalId: "t_1", title: "build", kind: "shell" },
      { terminalId: "t_2", title: "claude", kind: "claude" },
    ])
    expect(device.windows.w_board.enrichment).toEqual({ projectName: "Platform Development" })
    expect(device.windowTypes.map((t: any) => t.type)).toEqual(["chat", "terminal", "board"])
  })

  it("ids desconocidos no rompen el enriquecimiento (campos omitidos)", async () => {
    const db = authDb()
    const { handlers } = setup({ db })
    await handlers.get("ui.report")!(
      ctx(OWNER, "sess_owner"),
      report({
        windows: {
          w_chat: { windowId: "w_chat", type: "chat", props: { channelId: "ch_x", agentId: "agent_x" } },
          w_board: { windowId: "w_board", type: "board", props: { projectId: "proj_x" } },
        },
        focusedWindowId: "w_chat",
      }),
    )
    const res = await handlers.get("ui.get-state")!(ctx(OWNER, "sess_owner"), {
      workspaceId: WORKSPACE,
    })
    expect(res.devices[0].windows.w_chat.enrichment).toBeUndefined()
    expect(res.devices[0].windows.w_board.enrichment).toBeUndefined()
  })
})

// ── ui.command — authz + validación ──────────────────────────────────────────

describe("ui.command — authz y validación", () => {
  it("read-role: FORBIDDEN_WORKSPACE_ROLE (no puede comandar)", async () => {
    const { handlers } = setup({ db: authDb() })
    await expect(
      handlers.get("ui.command")!(ctx(READER), {
        workspaceId: WORKSPACE,
        command: "open-window",
        windowType: "chat",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_WORKSPACE_ROLE" })
  })

  it("UI_BAD_COMMAND: command desconocido / payloads incompletos / props inválidos", async () => {
    const { handlers } = setup({ db: authDb() })
    const call = (data: any) =>
      handlers.get("ui.command")!(ctx(OWNER), { workspaceId: WORKSPACE, ...data })

    await expect(call({ command: "nope" })).rejects.toMatchObject({ code: "UI_BAD_COMMAND" })
    await expect(call({ command: "open-window" })).rejects.toMatchObject({ code: "UI_BAD_COMMAND" })
    await expect(call({ command: "close-window" })).rejects.toMatchObject({ code: "UI_BAD_COMMAND" })
    await expect(call({ command: "focus-window" })).rejects.toMatchObject({ code: "UI_BAD_COMMAND" })
    await expect(call({ command: "set-active-desktop" })).rejects.toMatchObject({
      code: "UI_BAD_COMMAND",
    })
    await expect(
      call({ command: "update-window-props", windowId: "w1" }),
    ).rejects.toMatchObject({ code: "UI_BAD_COMMAND" })
    await expect(
      call({ command: "open-window", windowType: "chat", props: "nope" }),
    ).rejects.toMatchObject({ code: "UI_BAD_COMMAND" })
    await expect(
      call({ command: "open-window", windowType: "chat", target: "" }),
    ).rejects.toMatchObject({ code: "UI_BAD_COMMAND" })
  })

  it("el actor del domain_request aporta el workspaceId cuando el payload no lo lleva", async () => {
    const { handlers, pubSubService } = setup({ db: authDb() })
    // La sesión que RECIBE el comando es la del frontend del owner (sess_owner,
    // auto-suscripta por ui.report); el actor del bridge es el emisor.
    pubSubService.openSession("sess_owner")
    await handlers.get("ui.report")!(ctx(OWNER, "sess_owner"), report())

    const res = await handlers.get("ui.command")!(actorCtx(OWNER, WORKSPACE), {
      command: "close-window",
      windowId: "w_chat",
    })
    expect(res).toEqual({ delivered: 1, target: "all" })
  })
})

// ── ui.command — targets y delivery (REQ-4, AC-3/4/6) ───────────────────────

describe("ui.command — targets y delivery", () => {
  async function twoDevices(handlers: any, pubSubService: any) {
    pubSubService.openSession("sess_web")
    pubSubService.openSession("sess_iphone")
    await handlers.get("ui.report")!(
      ctx(OWNER, "sess_web"),
      report({ deviceId: "dev_web", deviceLabel: "Web · Chrome" }),
    )
    await handlers.get("ui.report")!(
      ctx(OWNER, "sess_iphone"),
      report({ deviceId: "dev_iphone", deviceLabel: "iPhone", focusedWindowId: "w_term" }),
    )
  }

  it("broadcast (default 'all') → topic user-wide, delivered = sesiones suscritas", async () => {
    const { handlers, pubSubService } = setup({ db: authDb() })
    await twoDevices(handlers, pubSubService)

    const res = await handlers.get("ui.command")!(ctx(OWNER, "sess_web"), {
      workspaceId: WORKSPACE,
      command: "open-window",
      windowType: "chat",
      props: { agentId: "agent_alice" },
    })
    expect(res).toEqual({ delivered: 2, target: "all" })
    const sent = pubSubService.broadcasts.find((b) => b.event.type === "ui_command")
    expect(sent?.topic).toBe(uiCommandsTopic(OWNER, WORKSPACE))
    expect(sent?.event.command).toMatchObject({
      commandId: "cmd_1",
      command: "open-window",
      target: "all",
      windowType: "chat",
      focus: true,
    })
  })

  it("frontend action (default 'active') → solo el device más reciente", async () => {
    const { handlers, pubSubService } = setup({ db: authDb() })
    await twoDevices(handlers, pubSubService)

    const res = await handlers.get("ui.command")!(ctx(OWNER, "sess_web"), {
      workspaceId: WORKSPACE,
      command: "set-active-desktop",
      // d1: el fixture report() solo define d1 — pedir d2 aquí nació roto
      // (UI_UNKNOWN_DESKTOP) desde 9cd11a390; el foco de este test es el
      // target 'active', no la validación de desktop.
      desktopId: "d1",
    })
    // dev_iphone reportó último → es el active.
    expect(res).toEqual({ delivered: 1, target: "dev_iphone" })
    const sent = pubSubService.broadcasts.find((b) => b.event.type === "ui_command")
    expect(sent?.topic).toBe(uiDeviceTopic(OWNER, WORKSPACE, "dev_iphone"))
    expect(sent?.event.deviceId).toBe("dev_iphone")
  })

  it("deviceId explícito → solo ese device; el otro no recibe", async () => {
    const { handlers, pubSubService } = setup({ db: authDb() })
    await twoDevices(handlers, pubSubService)

    const res = await handlers.get("ui.command")!(ctx(OWNER, "sess_web"), {
      workspaceId: WORKSPACE,
      command: "focus-window",
      windowId: "w_chat",
      target: "dev_web",
    })
    expect(res).toEqual({ delivered: 1, target: "dev_web" })
    expect(pubSubService.broadcasts.find((b) => b.event.type === "ui_command")?.topic).toBe(
      uiDeviceTopic(OWNER, WORKSPACE, "dev_web"),
    )
  })

  it("UI_UNKNOWN_DEVICE: deviceId desconocido u offline, listando los online", async () => {
    const { handlers, pubSubService } = setup({ db: authDb() })
    await twoDevices(handlers, pubSubService)

    const unknown = await handlers
      .get("ui.command")!(ctx(OWNER, "sess_web"), {
        workspaceId: WORKSPACE,
        command: "focus-window",
        windowId: "w_chat",
        target: "dev_nope",
      })
      .catch((err: any) => err)
    expect(unknown.code).toBe("UI_UNKNOWN_DEVICE")
    expect(unknown.message).toContain("dev_web")
    expect(unknown.message).toContain("dev_iphone")
    expect(pubSubService.broadcasts.filter((b) => b.event.type === "ui_command")).toHaveLength(0)
  })

  it("'active' sin devices online → delivered: 0 (offline explícito, no error)", async () => {
    const { handlers } = setup({ db: authDb() })
    const res = await handlers.get("ui.command")!(ctx(OWNER), {
      workspaceId: WORKSPACE,
      command: "focus-window",
      windowId: "w_chat",
    })
    expect(res).toEqual({ delivered: 0, target: "active" })
  })

  it("cada comando lleva un commandId único (dedup client-side)", async () => {
    const { handlers, pubSubService, newCommandId } = setup({ db: authDb() })
    pubSubService.openSession("sess_web")
    await handlers.get("ui.report")!(ctx(OWNER, "sess_web"), report())

    const ids = new Set<string>()
    for (let i = 0; i < 3; i++) {
      await handlers.get("ui.command")!(ctx(OWNER, "sess_web"), {
        workspaceId: WORKSPACE,
        command: "close-window",
        windowId: "w_chat",
      })
      const sent = pubSubService.broadcasts.filter((b) => b.event.type === "ui_command").at(-1)
      ids.add(sent!.event.command.commandId)
    }
    expect(ids.size).toBe(3)
    expect(newCommandId()).toBeTruthy()
  })
})

// ── ui.command — rate limit (NFR-3, AC-9) ────────────────────────────────────

describe("ui.command — rate limit", () => {
  it("el comando 21 en un minuto → UI_RATE_LIMITED con retry hint", async () => {
    const { handlers, advance } = setup({ db: authDb() })
    const call = () =>
      handlers.get("ui.command")!(ctx(OWNER, "sess_web"), {
        workspaceId: WORKSPACE,
        command: "close-window",
        windowId: "w_chat",
      })
    for (let i = 0; i < 20; i++) {
      await call()
    }
    const err = await call().catch((e: any) => e)
    expect(err.code).toBe("UI_RATE_LIMITED")
    expect(err.message).toMatch(/Retry in \d+s/)

    // Tras la ventana, vuelve a funcionar.
    advance(60_001)
    await expect(call()).resolves.toBeTruthy()
  })

  it("el 6º open-window en un minuto → UI_RATE_LIMITED (5 opens/min)", async () => {
    const { handlers } = setup({ db: authDb() })
    const open = () =>
      handlers.get("ui.command")!(ctx(OWNER, "sess_web"), {
        workspaceId: WORKSPACE,
        command: "open-window",
        windowType: "chat",
      })
    for (let i = 0; i < 5; i++) {
      await open()
    }
    await expect(open()).rejects.toMatchObject({ code: "UI_RATE_LIMITED" })
    // El límite de opens no consume el de comandos generales: un close sigue OK.
    await expect(
      handlers.get("ui.command")!(ctx(OWNER, "sess_web"), {
        workspaceId: WORKSPACE,
        command: "close-window",
        windowId: "w_chat",
      }),
    ).resolves.toBeTruthy()
  })

  it("el límite es por app agente (bridge) / por sesión (frontend)", async () => {
    const { handlers } = setup({ db: authDb() })
    const close = (c: WsHandlerContext) =>
      handlers.get("ui.command")!(c, {
        workspaceId: WORKSPACE,
        command: "close-window",
        windowId: "w_chat",
      })
    for (let i = 0; i < 20; i++) await close(bridgeCtx(OWNER, "app_agent1"))
    await expect(close(bridgeCtx(OWNER, "app_agent1"))).rejects.toMatchObject({
      code: "UI_RATE_LIMITED",
    })
    // Otra app tiene su propio bucket…
    await expect(close(bridgeCtx(OWNER, "app_agent2"))).resolves.toBeTruthy()
    // …y una sesión frontend tampoco consume el bucket de la app.
    await expect(close(ctx(OWNER, "sess_front"))).resolves.toBeTruthy()
  })
})

// ── ui.subscribe / ui.unsubscribe ────────────────────────────────────────────

describe("ui.subscribe / ui.unsubscribe", () => {
  it("suscribe/desuscribe al topic de comandos del usuario (miembro; bridge rechazado)", async () => {
    const { handlers, pubSubService } = setup({ db: authDb() })
    const res = await handlers.get("ui.subscribe")!(ctx(OWNER, "sess_x"), {
      workspaceId: WORKSPACE,
    })
    expect(res.topic).toBe(uiCommandsTopic(OWNER, WORKSPACE))
    expect(pubSubService.deliveredOn(uiCommandsTopic(OWNER, WORKSPACE))).toBe(0) // sin sesión abierta

    await handlers.get("ui.unsubscribe")!(ctx(OWNER, "sess_x"), { workspaceId: WORKSPACE })
    expect(pubSubService.topics.get(uiCommandsTopic(OWNER, WORKSPACE))?.size ?? 0).toBe(0)

    await expect(
      handlers.get("ui.subscribe")!(bridgeCtx(OWNER), { workspaceId: WORKSPACE }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      handlers.get("ui.subscribe")!(ctx(OUTSIDER), { workspaceId: WORKSPACE }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_WORKSPACE" })
  })
})


// ── ui.command browser.* — request-response (Teros Desktop F3) ───────────────

/** Report con una tab browser (w_tab) abierta — el dispositivo desktop. */
function browserReport(overrides: Partial<UiStateReport> = {}): UiStateReport {
  return report({
    deviceId: "dev_desktop",
    deviceLabel: "Teros Desktop",
    windows: {
      w_tab: { windowId: "w_tab", type: "browser", props: { url: "https://github.com" }, title: "GitHub" },
      w_chat: { windowId: "w_chat", type: "chat", props: { channelId: "ch_1", agentId: "agent_alice" } },
    },
    focusedWindowId: "w_tab",
    ...overrides,
  })
}

/** Setup con el desktop reportando desde sess_desktop (abierto y suscrito). */
function setupDesktop(opts: { timeoutMs?: number } = {}) {
  const t = setup({
    db: authDb(),
    ...(opts.timeoutMs !== undefined ? { browserCommandTimeoutMs: opts.timeoutMs } : {}),
  })
  t.pubSubService.openSession("sess_desktop")
  void t.handlers.get("ui.report")!(ctx(OWNER, "sess_desktop"), browserReport())
  return t
}

/** Deja que un handler async avance hasta su primer await. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe("ui.command browser.* — validación", () => {
  it("UI_BAD_COMMAND: sin tabId / target 'all' / payload inválido por kind", async () => {
    const { handlers } = setupDesktop()
    const call = (data: any) =>
      handlers.get("ui.command")!(ctx(OWNER), { workspaceId: WORKSPACE, ...data })

    await expect(call({ command: "browser.get-state" })).rejects.toMatchObject({ code: "UI_BAD_COMMAND" })
    await expect(call({ command: "browser.get-state", target: "all", tabId: "w_tab" })).rejects.toMatchObject({
      code: "UI_BAD_COMMAND",
    })
    await expect(call({ command: "browser.open-url", tabId: "w_tab" })).rejects.toMatchObject({ code: "UI_BAD_COMMAND" })
    await expect(call({ command: "browser.click", tabId: "w_tab" })).rejects.toMatchObject({ code: "UI_BAD_COMMAND" })
    await expect(call({ command: "browser.type", tabId: "w_tab" })).rejects.toMatchObject({ code: "UI_BAD_COMMAND" })
    await expect(call({ command: "browser.type", tabId: "w_tab", text: "hi", observe: "nope" })).rejects.toMatchObject({
      code: "UI_BAD_COMMAND",
    })
    await expect(call({ command: "browser.control", tabId: "w_tab", verb: "nope" })).rejects.toMatchObject({
      code: "UI_BAD_COMMAND",
    })
  })

  it("[DBAC-AC-7] browser.scroll / browser.press-key: payloads inválidos → UI_BAD_COMMAND", async () => {
    const { handlers } = setupDesktop()
    const call = (data: Record<string, unknown>) =>
      handlers.get("ui.command")!(ctx(OWNER), { workspaceId: WORKSPACE, ...data })
    await expect(call({ command: "browser.scroll", tabId: "w_tab" })).rejects.toMatchObject({ code: "UI_BAD_COMMAND" })
    await expect(call({ command: "browser.scroll", tabId: "w_tab", direction: "sideways" })).rejects.toMatchObject({
      code: "UI_BAD_COMMAND",
    })
    await expect(call({ command: "browser.scroll", tabId: "w_tab", direction: "down", amount: 0 })).rejects.toMatchObject({
      code: "UI_BAD_COMMAND",
    })
    await expect(call({ command: "browser.press-key", tabId: "w_tab" })).rejects.toMatchObject({ code: "UI_BAD_COMMAND" })
    await expect(
      call({ command: "browser.press-key", tabId: "w_tab", key: "Enter", modifiers: ["Hyper"] }),
    ).rejects.toMatchObject({ code: "UI_BAD_COMMAND" })
  })

  it("[DBAC-AC-7] browser.scroll / browser.press-key: payloads válidos llegan a la sesión con correlationId", async () => {
    const { handlers, pubSubService } = setupDesktop()
    const scroll = handlers.get("ui.command")!(ctx(OWNER), {
      workspaceId: WORKSPACE,
      command: "browser.scroll",
      tabId: "w_tab",
      direction: "down",
      amount: 300,
      observe: "none",
    })
    await tick()
    const sentScroll = pubSubService.directSends[0]
    expect(sentScroll.payload.command).toMatchObject({ command: "browser.scroll", tabId: "w_tab", direction: "down", amount: 300, observe: "none" })
    expect(typeof sentScroll.payload.command.correlationId).toBe("string")
    await handlers.get("ui.command-result")!(ctx(OWNER, "sess_desktop"), {
      workspaceId: WORKSPACE,
      correlationId: sentScroll.payload.command.correlationId,
      ok: true,
      result: { scrolled: { direction: "down", amount: 300 } },
    })
    expect(await scroll).toMatchObject({ ok: true, answered: true, result: { scrolled: { direction: "down", amount: 300 } } })

    const press = handlers.get("ui.command")!(ctx(OWNER), {
      workspaceId: WORKSPACE,
      command: "browser.press-key",
      tabId: "w_tab",
      key: "Enter",
      modifiers: ["Shift"],
      ref: "e3",
    })
    await tick()
    const sentPress = pubSubService.directSends[1]
    expect(sentPress.payload.command).toMatchObject({ command: "browser.press-key", key: "Enter", modifiers: ["Shift"], ref: "e3" })
    await handlers.get("ui.command-result")!(ctx(OWNER, "sess_desktop"), {
      workspaceId: WORKSPACE,
      correlationId: sentPress.payload.command.correlationId,
      ok: true,
      result: { pressed: { key: "Enter", modifiers: ["Shift"] } },
    })
    expect(await press).toMatchObject({ ok: true, answered: true })
  })

  it("UI_UNKNOWN_TAB: tabId que no existe — lista las browser tabs del device", async () => {
    const { handlers } = setupDesktop()
    await expect(
      handlers.get("ui.command")!(ctx(OWNER), {
        workspaceId: WORKSPACE,
        command: "browser.get-state",
        tabId: "w_nope",
      }),
    ).rejects.toMatchObject({ code: "UI_UNKNOWN_TAB" })
  })

  it("UI_BAD_COMMAND: tabId de una ventana NO browser", async () => {
    const { handlers } = setupDesktop()
    await expect(
      handlers.get("ui.command")!(ctx(OWNER), {
        workspaceId: WORKSPACE,
        command: "browser.get-state",
        tabId: "w_chat",
      }),
    ).rejects.toMatchObject({ code: "UI_BAD_COMMAND" })
  })
})

describe("ui.command browser.* — request-response", () => {
  it("flujo completo: comando → 1 sesión → correlationId → respuesta → outcome al agente", async () => {
    const { handlers, pubSubService } = setupDesktop()
    const commandPromise = handlers.get("ui.command")!(ctx(OWNER), {
      workspaceId: WORKSPACE,
      command: "browser.get-state",
      tabId: "w_tab",
    })

    // El comando fue a UNA sesión (sess_desktop), con correlationId en el envelope.
    await tick() // el handler es async: deja que llegue al ws.send antes de inspeccionar
    expect(pubSubService.directSends.length).toBe(1)
    const sent = pubSubService.directSends[0]
    expect(sent.sessionId).toBe("sess_desktop")
    expect(sent.payload.type).toBe("ui_command")
    expect(sent.payload.command.command).toBe("browser.get-state")
    expect(sent.payload.command.tabId).toBe("w_tab")
    expect(typeof sent.payload.command.correlationId).toBe("string")

    // El cliente responde desde LA MISMA sesión → el agente recibe el resultado.
    const reply = await handlers.get("ui.command-result")!(ctx(OWNER, "sess_desktop"), {
      workspaceId: WORKSPACE,
      correlationId: sent.payload.command.correlationId,
      ok: true,
      result: { url: "https://github.com", title: "GitHub", snapshot: '- button "Sign in" [ref=e12]' },
    })
    expect(reply).toEqual({ ok: true, matched: true })

    const outcome = await commandPromise
    expect(outcome).toMatchObject({
      command: "browser.get-state",
      delivered: true,
      answered: true,
      ok: true,
      target: "dev_desktop",
    })
    expect((outcome as any).result.snapshot).toContain("[ref=e12]")
  })

  it("respuesta desde OTRA sesión: dropped (matched:false) — el pending espera a la suya", async () => {
    const { handlers, pubSubService } = setupDesktop()
    // Otro device (p.ej. el iPhone) reportando desde su propia sesión — NO es
    // sesión de dev_desktop, así que su respuesta no puede matchear el pending.
    pubSubService.openSession("sess_other")
    void handlers.get("ui.report")!(ctx(OWNER, "sess_other"), browserReport({ deviceId: "dev_other" }))

    const commandPromise = handlers.get("ui.command")!(ctx(OWNER), {
      workspaceId: WORKSPACE,
      command: "browser.get-state",
      tabId: "w_tab",
      target: "dev_desktop", // explícito: dev_other reportó último y sería el 'active'
    })
    await tick() // deja que el handler llegue al ws.send
    const sent = pubSubService.directSends.at(-1)!

    // Respuesta desde la sesión equivocada → no matchea.
    const reply = await handlers.get("ui.command-result")!(ctx(OWNER, "sess_other"), {
      workspaceId: WORKSPACE,
      correlationId: sent.payload.command.correlationId,
      ok: true,
      result: { snapshot: "fake" },
    })
    expect(reply).toEqual({ ok: true, matched: false })

    // La sesión correcta responde → resuelve.
    await handlers.get("ui.command-result")!(ctx(OWNER, sent.sessionId), {
      workspaceId: WORKSPACE,
      correlationId: sent.payload.command.correlationId,
      ok: true,
      result: { snapshot: "real" },
    })
    const outcome = await commandPromise
    expect((outcome as any).result.snapshot).toBe("real")
  })

  it("error del executor (agent_control_disabled): ok:false + code viaja al agente tal cual", async () => {
    const { handlers, pubSubService } = setupDesktop()
    const commandPromise = handlers.get("ui.command")!(ctx(OWNER), {
      workspaceId: WORKSPACE,
      command: "browser.click",
      tabId: "w_tab",
      ref: "e12",
    })
    await tick() // deja que el handler llegue al ws.send
    const sent = pubSubService.directSends[0]
    await handlers.get("ui.command-result")!(ctx(OWNER, "sess_desktop"), {
      workspaceId: WORKSPACE,
      correlationId: sent.payload.command.correlationId,
      ok: false,
      code: "agent_control_disabled",
      message: "consent is off",
    })
    const outcome = await commandPromise
    expect(outcome).toMatchObject({
      answered: true,
      ok: false,
      code: "agent_control_disabled",
      message: "consent is off",
    })
  })

  it("timeout: sin respuesta → UI_COMMAND_TIMEOUT (el agente nunca se cuelga)", async () => {
    // bun:test: setTimeout real — timeout corto para no frenar la suite.
    const { handlers, pubSubService } = setupDesktop({ timeoutMs: 30 })
    const commandPromise = handlers.get("ui.command")!(ctx(OWNER), {
      workspaceId: WORKSPACE,
      command: "browser.screenshot",
      tabId: "w_tab",
    })
    const outcome = await commandPromise
    expect(outcome).toMatchObject({
      command: "browser.screenshot",
      delivered: true,
      answered: false,
      ok: false,
      code: "UI_COMMAND_TIMEOUT",
    })
    // Late answer after timeout → dropped, no crash.
    const sent = pubSubService.directSends[0]
    const reply = await handlers.get("ui.command-result")!(ctx(OWNER, "sess_desktop"), {
      workspaceId: WORKSPACE,
      correlationId: sent.payload.command.correlationId,
      ok: true,
      result: { late: true },
    })
    expect(reply).toEqual({ ok: true, matched: false })
  })

  it("ui.command-result: bridge FORBIDDEN; malformed → UI_BAD_RESULT; ok:false sin code → UI_BAD_RESULT", async () => {
    const { handlers } = setupDesktop()
    await expect(
      handlers.get("ui.command-result")!(bridgeCtx(OWNER), {
        workspaceId: WORKSPACE,
        correlationId: "cmd_1",
        ok: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      handlers.get("ui.command-result")!(ctx(OWNER, "sess_desktop"), { workspaceId: WORKSPACE, ok: true }),
    ).rejects.toMatchObject({ code: "UI_BAD_RESULT" })
    await expect(
      handlers.get("ui.command-result")!(ctx(OWNER, "sess_desktop"), {
        workspaceId: WORKSPACE,
        correlationId: "cmd_1",
        ok: "yes",
      }),
    ).rejects.toMatchObject({ code: "UI_BAD_RESULT" })
    await expect(
      handlers.get("ui.command-result")!(ctx(OWNER, "sess_desktop"), {
        workspaceId: WORKSPACE,
        correlationId: "cmd_1",
        ok: false,
      }),
    ).rejects.toMatchObject({ code: "UI_BAD_RESULT" })
  })

  it("delivered:0 cuando no hay device online — igual que el resto de comandos", async () => {
    const { handlers } = setup({ db: authDb() })
    const res = await handlers.get("ui.command")!(ctx(OWNER), {
      workspaceId: WORKSPACE,
      command: "browser.get-state",
      tabId: "w_tab",
    })
    expect(res).toEqual({ delivered: 0, target: "active" })
  })
})
