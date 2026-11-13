import { describe, expect, it } from "bun:test"
import type { WsHandlerContext } from "@teros/shared"
import { register } from "../../src/handlers/domains/terminal/index"
import { PtyManager } from "../../src/services/pty-manager"

const WORKSPACE = "work_a"
const ada = (): WsHandlerContext =>
  ({ userId: "u_ada", sessionId: "sess_ada", ip: "127.0.0.1" }) as any
const quinn = (): WsHandlerContext =>
  ({ userId: "u_quinn", sessionId: "sess_quinn", ip: "127.0.0.1" }) as any
const agent = (): WsHandlerContext =>
  ({ userId: "u_ada", sessionId: "mca:app_term_a", ip: "mca:mca.teros.terminal" }) as any

function makeHost() {
  return {
    appId: "app_bash_a",
    key: "app_bash_a",
    container: "teros-term-fake",
    workspaceId: WORKSPACE,
    onAttr: null,
    onPause: null,
    onDisconnect: null,
    async createWindow(meta: any, opts: any) {
      return {
        ...meta,
        windowId: "@1",
        paneId: `%${meta.terminalId}`,
        panePid: 100,
        cols: opts.cols,
        rows: opts.rows,
        activityAt: Date.now(),
        command: "",
        agentState: "",
        lease: "",
      }
    },
    bind() {},
    async write() {},
    async resize() {},
    async kill() {},
    async setPaneOption() {},
    async setWindowOption() {},
    async screen() {
      return {
        cols: 80,
        rows: 24,
        lines: ["$ "],
        cursor: { x: 0, y: 0, visible: true },
        title: "",
        command: "",
        alternateScreen: false,
      }
    },
  } as any
}

const db = {
  collection: (name: string) => ({
    findOne: async (filter: any) => {
      if (name === "workspaces")
        return { workspaceId: filter.workspaceId, ownerId: "u_ada", status: "active" }
      if (name === "workspace_members" && filter.userId === "u_quinn")
        return { workspaceId: WORKSPACE, userId: "u_quinn", role: "write", status: "active" }
      return null
    },
  }),
} as any

async function setup(idleTakeoverMs = 60_000) {
  const manager = new PtyManager({ broadcastToTopic() {} } as any, { lease: { idleTakeoverMs } })
  const host = makeHost()
  await manager.createInHost(host, "t_ada", 80, 24, WORKSPACE, {
    title: "Shell 1",
    kind: "shell",
    createdBy: "u_ada",
  })
  await manager.createInHost(host, "t_agent", 80, 24, WORKSPACE, {
    title: "Build",
    kind: "agent",
    createdBy: "agent:app_term_a",
  })
  const sent: Array<{ topic: string; event: any }> = []
  const subscriptions: Array<{ session: string; topic: string }> = []
  const handlers = new Map<string, (ctx: WsHandlerContext, data: unknown) => Promise<any>>()
  register({ register: (a: string, h: any) => handlers.set(a, h) } as any, {
    pubSubService: {
      subscribeSession: (session: string, topic: string) => subscriptions.push({ session, topic }),
      unsubscribeSession: (session: string, topic: string) => {
        for (let i = subscriptions.length - 1; i >= 0; i--)
          if (subscriptions[i].session === session && subscriptions[i].topic === topic)
            subscriptions.splice(i, 1)
      },
      broadcastToTopic: (topic: string, event: any) => sent.push({ topic, event }),
    } as any,
    ptyManager: manager,
    mcaService: {
      getApp: async (appId: string) => ({ appId, ownerId: WORKSPACE, mcaId: "mca.teros.bash" }),
    } as any,
    mcaManager: {} as any,
    db,
    identities: {
      human: async (id: string) => ({ kind: "human", id, name: id }),
      agent: async () => ({ kind: "agent", id: "agent_rex", name: "Rex" }),
    },
  })
  const call = (action: string, ctx: WsHandlerContext, data: Record<string, unknown> = {}) =>
    handlers.get(action)!(ctx, data)
  const ids = async (ctx: WsHandlerContext) =>
    (await call("terminal.list", ctx)).sessions.map((s: any) => s.terminalId).sort()
  return { manager, call, ids, sent, subscriptions }
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (err) => (err as { code?: string }).code ?? String(err),
  )

describe("agent control: one flag per session", () => {
  it("[TW-AC-9] off in a session a person opens, on in a session an agent opens", async () => {
    const { manager } = await setup()
    expect(manager.describe("t_ada")).toMatchObject({ agentControl: false, openedBy: "person" })
    expect(manager.describe("t_agent")).toMatchObject({ agentControl: true, openedBy: "agent" })
  })

  it("[TW-AC-10] with the flag off, an agent cannot list, read, write, wait on, rename or close a person's session", async () => {
    const { call, ids, manager } = await setup()
    expect(await ids(agent())).toEqual(["t_agent"])
    for (const [action, data] of [
      ["terminal.read", {}],
      ["terminal.screen", {}],
      ["terminal.write", { data: "ls", sendEnter: true }],
      ["terminal.wait", { until: "quiet", quietMs: 100, timeoutMs: 200 }],
      ["terminal.update", { title: "mine now" }],
      ["terminal.destroy", {}],
      ["terminal.requestWheel", {}],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(await code(call(action, agent(), { terminalId: "t_ada", ...data }))).toBe(
        "FORBIDDEN_TERMINAL",
      )
    }
    expect(manager.has("t_ada")).toBe(true)
    expect(manager.describe("t_ada")?.title).toBe("Shell 1")
  })

  it("[TW-AC-11] with the flag on, an agent reads and types; not within 60 s of a person's keys", async () => {
    const { call, ids, manager } = await setup()
    await call("terminal.agentControl", ada(), { terminalId: "t_ada", enabled: true })
    expect(manager.describe("t_ada")?.agentControl).toBe(true)
    expect(await ids(agent())).toEqual(["t_ada", "t_agent"])
    expect(await code(call("terminal.screen", agent(), { terminalId: "t_ada" }))).toBe("ok")
    expect(await code(call("terminal.write", agent(), { terminalId: "t_ada", data: "ls" }))).toBe(
      "ok",
    )
    expect(manager.describe("t_ada")?.driver).toMatchObject({ kind: "agent", id: "agent_rex" })
    expect(await code(call("terminal.input", ada(), { terminalId: "t_ada", data: "x" }))).toBe(
      "WHEEL_HELD",
    )
  })

  it("[TW-AC-11] a person who typed in the last 60 s keeps the keyboard even with the flag on", async () => {
    const { call } = await setup()
    await call("terminal.agentControl", ada(), { terminalId: "t_ada", enabled: true })
    await call("terminal.input", ada(), { terminalId: "t_ada", data: "x" })
    expect(await code(call("terminal.write", agent(), { terminalId: "t_ada", data: "ls" }))).toBe(
      "WHEEL_HELD",
    )
  })

  it("[TW-AC-12] switching it off makes that person the driver and stops the agent", async () => {
    const { call, manager } = await setup()
    await call("terminal.agentControl", ada(), { terminalId: "t_ada", enabled: true })
    await call("terminal.write", agent(), { terminalId: "t_ada", data: "ls" })
    const off = await call("terminal.agentControl", ada(), { terminalId: "t_ada", enabled: false })
    expect(off).toMatchObject({ agentControl: false, driver: { kind: "human", id: "u_ada" } })
    expect(await code(call("terminal.input", ada(), { terminalId: "t_ada", data: "x" }))).toBe("ok")
    expect(await code(call("terminal.read", agent(), { terminalId: "t_ada" }))).toBe(
      "FORBIDDEN_TERMINAL",
    )
    expect(manager.describe("t_ada")?.agentControl).toBe(false)
  })

  it("[TW-AC-12] in a person's session only its opener switches the flag: a member who watches it cannot", async () => {
    const { call, manager } = await setup()
    await call("terminal.watchable", ada(), { terminalId: "t_ada", enabled: true })
    expect(
      await code(call("terminal.agentControl", quinn(), { terminalId: "t_ada", enabled: true })),
    ).toBe("TERMINAL_VIEW_ONLY")
    expect(manager.describe("t_ada")?.agentControl).toBe(false)
  })

  it("[TW-AC-12] in an agent's session any member switches it off; it comes back on by itself after the idle time", async () => {
    const { call, manager } = await setup(30)
    await call("terminal.agentControl", quinn(), { terminalId: "t_agent", enabled: false })
    expect(manager.describe("t_agent")).toMatchObject({
      agentControl: false,
      driver: { kind: "human", id: "u_quinn" },
    })
    expect(await code(call("terminal.write", agent(), { terminalId: "t_agent", data: "ls" }))).toBe(
      "WHEEL_HELD",
    )
    await new Promise((r) => setTimeout(r, 60))
    expect(await code(call("terminal.write", agent(), { terminalId: "t_agent", data: "ls" }))).toBe(
      "ok",
    )
    expect(manager.describe("t_agent")).toMatchObject({
      agentControl: true,
      driver: { kind: "agent" },
    })
  })

  it("[TW-AC-12] in a person's session the flag stays off however long they are idle", async () => {
    const { call, manager } = await setup(30)
    await call("terminal.agentControl", ada(), { terminalId: "t_ada", enabled: true })
    await call("terminal.agentControl", ada(), { terminalId: "t_ada", enabled: false })
    await new Promise((r) => setTimeout(r, 60))
    expect(await code(call("terminal.write", agent(), { terminalId: "t_ada", data: "ls" }))).toBe(
      "FORBIDDEN_TERMINAL",
    )
    expect(manager.describe("t_ada")?.agentControl).toBe(false)
  })

  it("[TW-AC-13] an agent refused in a session it can see asks; switching the flag on answers it", async () => {
    const { call, manager } = await setup()
    await call("terminal.agentControl", quinn(), { terminalId: "t_agent", enabled: false })
    const asked = call("terminal.requestWheel", agent(), {
      terminalId: "t_agent",
      reason: "finish the build",
      timeoutMs: 2000,
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(manager.describe("t_agent")?.wheelRequest?.agent.id).toBe("agent_rex")
    await call("terminal.agentControl", quinn(), { terminalId: "t_agent", enabled: true })
    expect((await asked).outcome).toBe("approved")
    expect(manager.describe("t_agent")).toMatchObject({
      agentControl: true,
      wheelRequest: null,
      driver: { kind: "agent", id: "agent_rex" },
    })
  })

  it("[TW-AC-9] the flag survives a restart: it is part of what the session saves", async () => {
    const { call, manager } = await setup()
    await call("terminal.agentControl", ada(), { terminalId: "t_ada", enabled: true })
    await call("terminal.watchable", ada(), { terminalId: "t_ada", enabled: true })
    const saved = JSON.parse(
      JSON.stringify((manager as any).sessions.get("t_ada").lease.snapshot()),
    )
    expect(saved).toMatchObject({ agentControl: true, watchable: true })
    const other = new PtyManager({ broadcastToTopic() {} } as any)
    await other.createInHost(makeHost(), "t_ada", 80, 24, WORKSPACE, {
      title: "Shell 1",
      kind: "shell",
      createdBy: "u_ada",
    })
    ;(other as any).sessions.get("t_ada").lease.restore(saved)
    expect(other.describe("t_ada")).toMatchObject({ agentControl: true, watchable: true })
  })
})

describe("sessions are private to the person who opened them", () => {
  it("[TW-AC-14] another write member does not list, read, type in or rename a private session", async () => {
    const { call, ids } = await setup()
    expect(await ids(ada())).toEqual(["t_ada", "t_agent"])
    expect(await ids(quinn())).toEqual(["t_agent"])
    for (const [action, data] of [
      ["terminal.read", {}],
      ["terminal.screen", {}],
      ["terminal.input", { data: "x" }],
      ["terminal.update", { title: "hi" }],
      ["terminal.destroy", {}],
      ["terminal.subscribe", {}],
      ["terminal.agentControl", { enabled: true }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(await code(call(action, quinn(), { terminalId: "t_ada", ...data }))).toBe(
        "FORBIDDEN_TERMINAL",
      )
    }
  })

  it("[TW-AC-14] a private session's events reach only its opener's topic", async () => {
    const { call, sent, subscriptions } = await setup()
    await call("terminal.watch", quinn(), { workspaceId: WORKSPACE })
    expect(subscriptions.filter((s) => s.session === "sess_quinn").map((s) => s.topic)).toEqual([
      "terminals:work_a",
      "terminals:work_a:u_quinn",
    ])
    sent.length = 0
    await call("terminal.update", ada(), { terminalId: "t_ada", title: "Deploy" })
    expect(sent.length).toBeGreaterThan(0)
    expect([...new Set(sent.map((s) => s.topic))]).toEqual(["terminals:work_a:u_ada"])
  })

  it("[TW-AC-15] the opener lets the workspace watch it: members list it, read it and get its events", async () => {
    const { call, ids, sent, manager } = await setup()
    sent.length = 0
    expect(await call("terminal.watchable", ada(), { terminalId: "t_ada", enabled: true })).toEqual({
      ok: true,
      watchable: true,
    })
    expect(manager.describe("t_ada")?.watchable).toBe(true)
    expect(await ids(quinn())).toEqual(["t_ada", "t_agent"])
    expect(await code(call("terminal.screen", quinn(), { terminalId: "t_ada" }))).toBe("ok")
    expect(sent.at(-1)).toMatchObject({
      topic: "terminals:work_a",
      event: { reason: "watchable", session: { terminalId: "t_ada", watchable: true } },
    })
  })

  it("[TW-AC-15] only the opener lets the workspace watch, and stopping takes it away from the others", async () => {
    const { call, ids, sent } = await setup()
    expect(
      await code(call("terminal.watchable", quinn(), { terminalId: "t_agent", enabled: true })),
    ).toBe("NOT_WATCHABLE")
    await call("terminal.watchable", ada(), { terminalId: "t_ada", enabled: true })
    expect(
      await code(call("terminal.watchable", quinn(), { terminalId: "t_ada", enabled: false })),
    ).toBe("TERMINAL_VIEW_ONLY")
    sent.length = 0
    await call("terminal.watchable", ada(), { terminalId: "t_ada", enabled: false })
    expect(await ids(quinn())).toEqual(["t_agent"])
    expect(sent.map((s) => [s.topic, s.event.reason, s.event.session?.terminalId ?? null])).toEqual(
      [
        ["terminals:work_a", "unwatchable", null],
        ["terminals:work_a:u_ada", "watchable", "t_ada"],
      ],
    )
  })

  it("[TW-AC-16] a session an agent opened is visible to the workspace's write members", async () => {
    const { call, ids } = await setup()
    expect(await ids(quinn())).toContain("t_agent")
    expect(await code(call("terminal.screen", quinn(), { terminalId: "t_agent" }))).toBe("ok")
  })

  it("[TW-AC-17] sharing with members does not open a session to agents: that is the agent flag", async () => {
    const { call, ids } = await setup()
    await call("terminal.watchable", ada(), { terminalId: "t_ada", enabled: true })
    expect(await ids(agent())).toEqual(["t_agent"])
    expect(await code(call("terminal.read", agent(), { terminalId: "t_ada" }))).toBe(
      "FORBIDDEN_TERMINAL",
    )
  })
})

describe("access is checked on every way in, and again when it is taken away", () => {
  const outputOf = (subscriptions: Array<{ session: string; topic: string }>, topic: string) =>
    subscriptions.filter((x) => x.topic === topic).map((x) => x.session)

  it("[TW-AC-14] opening a session by its id is refused to another member and to an agent", async () => {
    const { call, subscriptions } = await setup()
    for (const ctx of [quinn(), agent()]) {
      expect(
        await code(call("terminal.create", ctx, { terminalId: "t_ada", appId: "app_bash_a" })),
      ).toBe("FORBIDDEN_TERMINAL")
    }
    expect(outputOf(subscriptions, "terminal:t_ada")).toEqual([])
  })

  it("[TW-AC-12] the old give-back action cannot switch the flag on for someone who may not", async () => {
    const { call, manager } = await setup()
    await call("terminal.watchable", ada(), { terminalId: "t_ada", enabled: true })
    expect(await code(call("terminal.giveBack", quinn(), { terminalId: "t_ada" }))).toBe(
      "TERMINAL_VIEW_ONLY",
    )
    expect(manager.describe("t_ada")?.agentControl).toBe(false)
  })

  it("[TW-AC-15] when sharing stops, the others stop receiving the session's output", async () => {
    const { call, subscriptions } = await setup()
    await call("terminal.watchable", ada(), { terminalId: "t_ada", enabled: true })
    await call("terminal.subscribe", quinn(), { terminalId: "t_ada" })
    await call("terminal.subscribe", ada(), { terminalId: "t_ada" })
    expect(outputOf(subscriptions, "terminal:t_ada")).toEqual(["sess_quinn", "sess_ada"])
    await call("terminal.watchable", ada(), { terminalId: "t_ada", enabled: false })
    expect(outputOf(subscriptions, "terminal:t_ada")).toEqual(["sess_ada"])
  })

  it("[TW-AC-10] when Agent is switched off, the agent stops receiving the session's output", async () => {
    const { call, subscriptions } = await setup()
    await call("terminal.agentControl", ada(), { terminalId: "t_ada", enabled: true })
    await call("terminal.subscribe", agent(), { terminalId: "t_ada" })
    expect(outputOf(subscriptions, "terminal:t_ada")).toEqual(["mca:app_term_a"])
    await call("terminal.agentControl", ada(), { terminalId: "t_ada", enabled: false })
    expect(outputOf(subscriptions, "terminal:t_ada")).toEqual([])
  })

  it("[TW-AC-15] a wait that was running when access went away returns nothing of the session", async () => {
    const { call } = await setup()
    await call("terminal.watchable", ada(), { terminalId: "t_ada", enabled: true })
    const waiting = code(
      call("terminal.wait", quinn(), {
        terminalId: "t_ada",
        until: "text",
        text: "never shown",
        timeoutMs: 250,
      }),
    )
    const waitingFor = code(
      call("terminal.waitFor", quinn(), {
        terminalId: "t_ada",
        pattern: "never shown",
        timeoutMs: 250,
        softTimeout: true,
      }),
    )
    await new Promise((r) => setTimeout(r, 40))
    await call("terminal.watchable", ada(), { terminalId: "t_ada", enabled: false })
    expect(await waiting).toBe("FORBIDDEN_TERMINAL")
    expect(await waitingFor).toBe("FORBIDDEN_TERMINAL")
  })
})
