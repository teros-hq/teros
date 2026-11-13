import { describe, expect, it, mock } from "bun:test"
import type { WsHandlerContext } from "@teros/shared"
import { register } from "../../src/handlers/domains/terminal/index"
import { PtyManager } from "../../src/services/pty-manager"

const APPS: Record<string, { appId: string; ownerId: string; mcaId: string }> = {
  app_term_a: { appId: "app_term_a", ownerId: "work_a", mcaId: "mca.teros.terminal" },
  app_term_b: { appId: "app_term_b", ownerId: "work_b", mcaId: "mca.teros.terminal" },
  app_bash_a: { appId: "app_bash_a", ownerId: "work_a", mcaId: "mca.teros.bash" },
  app_bash_b: { appId: "app_bash_b", ownerId: "work_b", mcaId: "mca.teros.bash" },
}

const agentOfA = (): WsHandlerContext =>
  ({ userId: "u_owner", sessionId: "mca:app_term_a", ip: "mca:mca.teros.terminal" }) as any
const owner = (): WsHandlerContext =>
  ({ userId: "u_owner", sessionId: "sess_owner", ip: "127.0.0.1" }) as any

function makeHost(workspaceId: string) {
  return {
    appId: `app_host_${workspaceId}`,
    key: `app_host_${workspaceId}`,
    container: `teros-term-${workspaceId}`,
    workspaceId,
    onAttr: null,
    onPause: null,
    onDisconnect: null,
    async createWindow(meta: any, opts: any) {
      return {
        ...meta,
        windowId: "@1",
        paneId: `%${workspaceId}`,
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
    findOne: async (filter: any) =>
      name === "workspaces"
        ? { workspaceId: filter.workspaceId, ownerId: "u_owner", status: "active" }
        : null,
  }),
} as any

async function setup() {
  const manager = new PtyManager({ broadcastToTopic() {} } as any)
  await manager.createInHost(makeHost("work_a"), "term_a", 80, 24, "work_a", {
    title: "A",
    kind: "shell",
    createdBy: "agent:app_term_x",
  })
  await manager.createInHost(makeHost("work_b"), "term_b", 80, 24, "work_b", {
    title: "B",
    kind: "shell",
    createdBy: "agent:app_term_x",
  })
  const handlers = new Map<string, (ctx: WsHandlerContext, data: unknown) => Promise<any>>()
  register({ register: (a: string, h: any) => handlers.set(a, h) } as any, {
    pubSubService: {
      subscribeSession: mock(() => {}),
      unsubscribeSession: mock(() => {}),
      broadcastToTopic: () => {},
    } as any,
    ptyManager: manager,
    mcaService: { getApp: async (appId: string) => APPS[appId] ?? null } as any,
    mcaManager: {} as any,
    db,
    identities: {
      human: async (id: string) => ({ kind: "human", id, name: id }),
      agent: async () => ({ kind: "agent", id: "agent_a", name: "Atlas" }),
    },
  })
  const call = (action: string, ctx: WsHandlerContext, data: Record<string, unknown> = {}) =>
    handlers.get(action)!(ctx, data)
  return { manager, call }
}

const SESSION_ACTIONS: Array<[string, Record<string, unknown>]> = [
  ["terminal.read", {}],
  ["terminal.screen", {}],
  ["terminal.write", { data: "echo pwned", sendEnter: true }],
  ["terminal.input", { data: "x" }],
  ["terminal.wait", { until: "quiet", quietMs: 100, timeoutMs: 200 }],
  ["terminal.waitFor", { pattern: "x", timeoutMs: 50, softTimeout: true }],
  ["terminal.status", {}],
  ["terminal.reveal", {}],
  ["terminal.update", { title: "renamed" }],
  ["terminal.resize", { cols: 10, rows: 5 }],
  ["terminal.subscribe", {}],
  ["terminal.destroy", {}],
]

describe("terminal isolation: an agent of workspace A and workspace B of the same owner", () => {
  it("terminal.list shows only A's sessions, whatever workspaceId the agent passes", async () => {
    const { call } = await setup()
    const all = await call("terminal.list", agentOfA())
    expect(all.sessions.map((s: any) => s.terminalId)).toEqual(["term_a"])
    const asked = await call("terminal.list", agentOfA(), { workspaceId: "work_b" })
    expect(asked.sessions).toEqual([])
  })

  for (const [action, data] of SESSION_ACTIONS) {
    it(`${action} on B's session is refused`, async () => {
      const { call, manager } = await setup()
      let code: string | undefined
      try {
        await call(action, agentOfA(), { terminalId: "term_b", ...data })
      } catch (err) {
        code = (err as { code?: string }).code
      }
      expect(code).toBe("FORBIDDEN_TERMINAL")
      expect(manager.has("term_b")).toBe(true)
    })
  }

  it("the agent still reads its own workspace's session", async () => {
    const { call } = await setup()
    const r = await call("terminal.read", agentOfA(), { terminalId: "term_a" })
    expect(typeof r.output).toBe("string")
  })

  it("terminal.create with B's bash app is refused", async () => {
    const { call } = await setup()
    let code: string | undefined
    try {
      await call("terminal.create", agentOfA(), { terminalId: "term_new", appId: "app_bash_b" })
    } catch (err) {
      code = (err as { code?: string }).code
    }
    expect(code).toBe("FORBIDDEN_WORKSPACE")
  })

  it("terminal.watch of B is refused to the agent", async () => {
    const { call } = await setup()
    let code: string | undefined
    try {
      await call("terminal.watch", agentOfA(), { workspaceId: "work_b" })
    } catch (err) {
      code = (err as { code?: string }).code
    }
    expect(code).toBe("FORBIDDEN_WORKSPACE")
  })

  it("a bridge call whose workspace can't be resolved is refused", async () => {
    const { call } = await setup()
    const ghost = { ...agentOfA(), sessionId: "mca:app_gone" } as WsHandlerContext
    let code: string | undefined
    try {
      await call("terminal.read", ghost, { terminalId: "term_a" })
    } catch (err) {
      code = (err as { code?: string }).code
    }
    expect(code).toBe("FORBIDDEN_TERMINAL")
  })

  it("the owner, in their own window, still reaches both workspaces", async () => {
    const { call } = await setup()
    const list = await call("terminal.list", owner())
    expect(list.sessions.map((s: any) => s.terminalId).sort()).toEqual(["term_a", "term_b"])
    const r = await call("terminal.read", owner(), { terminalId: "term_b" })
    expect(typeof r.output).toBe("string")
  })
})
