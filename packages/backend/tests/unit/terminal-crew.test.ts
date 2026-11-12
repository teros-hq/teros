/**
 * The terminal crew through the terminal domain, on a real PtyManager (fake
 * tmux host): taking the wheel refuses the agent's writes with a clear
 * message, an idle person loses it to the agent, an agent's terminal.wait
 * returns early when the wheel changes hands, the give-back note reaches the
 * agent once, two people typing are a conflict one of them yields, and the
 * driver is written to tmux (it survives a backend restart).
 */

import { describe, expect, it, mock } from "bun:test"
import type { WsHandlerContext } from "@teros/shared"
import { register } from "../../src/handlers/domains/terminal/index"
import { PtyManager } from "../../src/services/pty-manager"
import { parseLeaseSnapshot } from "../../src/services/terminal/driver-lease"

const human = (userId: string): WsHandlerContext =>
  ({ userId, sessionId: `sess_${userId}`, connectionId: "c1" }) as any
/** The MCA bridge (admin_request): userId = workspace owner, synthetic session. */
const bridge = (): WsHandlerContext =>
  ({ userId: "u_owner", sessionId: "mca:app_terminal", ip: "mca:mca.teros.terminal" }) as any

const NAMES: Record<string, string> = { u_iria: "Iria", u_lucia: "Lucía", u_owner: "Owner" }

function makeHost() {
  const sinks = new Map<string, { data(t: string): void; exit(c: number): void }>()
  const options: Array<[string, string, string]> = []
  const host: any = {
    appId: "app_fakehost01",
    container: "teros-term-fake",
    workspaceId: "work_1",
    onAttr: null,
    onPause: null,
    onDisconnect: null,
    options,
    async createWindow(meta: any, opts: any) {
      return {
        ...meta,
        windowId: "@1",
        paneId: "%1",
        panePid: 100,
        cols: opts.cols,
        rows: opts.rows,
        activityAt: Date.now(),
        command: "",
        agentState: "",
        lease: "",
      }
    },
    bind(_w: string, paneId: string, sink: any) {
      sinks.set(paneId, sink)
    },
    async write() {},
    async resize() {},
    async kill() {},
    async setPaneOption() {},
    async setWindowOption(windowId: string, name: string, value: string) {
      options.push([windowId, name, value])
    },
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
  }
  return host
}

function makeDb() {
  return {
    collection: (name: string) => ({
      findOne: async (filter: any) =>
        name === "workspaces"
          ? { workspaceId: filter.workspaceId, ownerId: "u_owner", status: "active" }
          : name === "workspace_members"
            ? { workspaceId: filter.workspaceId, userId: filter.userId, role: "write" }
            : null,
    }),
  } as any
}

async function setup(lease: { idleTakeoverMs?: number; conflictWindowMs?: number } = {}) {
  const manager = new PtyManager({ broadcastToTopic() {} } as any, { lease })
  const host = makeHost()
  await manager.createInHost(host, "t1", 100, 30, "work_1", {
    title: "Tests",
    kind: "claude",
    createdBy: "u_iria",
  })
  const handlers = new Map<string, (ctx: WsHandlerContext, data: unknown) => Promise<any>>()
  const events: Array<{ reason: string; session: any }> = []
  register({ register: (a: string, h: any) => handlers.set(a, h) } as any, {
    pubSubService: {
      subscribeSession: mock(() => {}),
      unsubscribeSession: mock(() => {}),
      broadcastToTopic: (_t: string, e: any) =>
        events.push({ reason: e.reason, session: e.session }),
    } as any,
    ptyManager: manager,
    mcaService: {} as any,
    mcaManager: {} as any,
    db: makeDb(),
    identities: {
      human: async (userId: string) => ({
        kind: "human",
        id: userId,
        name: NAMES[userId] ?? userId,
        avatarUrl: `/avatars/${userId}.png`,
      }),
      agent: async () => ({
        kind: "agent",
        id: "agent_atlas",
        name: "Atlas",
        avatarUrl: "/static/atlas.png",
      }),
    },
  })
  const call = (action: string, ctx: WsHandlerContext, data: Record<string, unknown>) =>
    handlers.get(action)!(ctx, { terminalId: "t1", ...data })
  return { manager, host, handlers, call, events }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("terminal crew: the wheel", () => {
  it("an agent write takes a free wheel; its identity comes from the agent record", async () => {
    const { call, manager, events } = await setup()
    await call("terminal.write", bridge(), { data: "ls", sendEnter: true })
    expect(manager.driver("t1")).toMatchObject({
      kind: "agent",
      id: "agent_atlas",
      name: "Atlas",
      avatarUrl: "/static/atlas.png",
    })
    const ev = events.find((e) => e.reason === "driver")
    expect(ev?.session.driver).toMatchObject({ kind: "agent", name: "Atlas" })
    expect(ev?.session.conflict).toBeNull()
    expect(Array.isArray(ev?.session.watchers)).toBe(true)
  })

  it("while a person holds the wheel the agent's write is refused with who has it", async () => {
    const { call } = await setup()
    await call("terminal.write", bridge(), { data: "ls", sendEnter: true })
    const took = await call("terminal.takeWheel", human("u_iria"), {})
    expect(took.driver).toMatchObject({
      kind: "human",
      id: "u_iria",
      name: "Iria",
      avatarUrl: "/avatars/u_iria.png",
    })
    for (const action of ["terminal.write", "terminal.input"]) {
      const err = await call(action, bridge(), { data: "x" }).catch((e) => e)
      expect(err.code).toBe("WHEEL_HELD")
      expect(err.message).toStartWith("Iria has the wheel; wait or ask them in chat")
    }
  })

  it("viewing is read-only: while an agent holds the wheel a person's keys are refused until they take it", async () => {
    const { call, manager } = await setup()
    await call("terminal.write", bridge(), { data: "ls", sendEnter: true })
    expect(manager.driver("t1")?.kind).toBe("agent")
    for (const action of ["terminal.write", "terminal.input"]) {
      const err = await call(action, human("u_iria"), { data: "x" }).catch((e) => e)
      expect(err.code).toBe("WHEEL_HELD")
      expect(err.message).toContain("Atlas has the wheel")
      expect(err.message).toContain("Take the wheel")
    }
    // The agent keeps the wheel: refusing the keys moved nothing.
    expect(manager.driver("t1")).toMatchObject({ kind: "agent", id: "agent_atlas" })
    // Taking the wheel (the button) is the way in — then typing works.
    await call("terminal.takeWheel", human("u_iria"), {})
    await call("terminal.input", human("u_iria"), { data: "y" })
    expect(manager.driver("t1")).toMatchObject({ kind: "human", id: "u_iria" })
  })

  it("a person idle at the wheel for longer than the idle window loses it to the agent", async () => {
    const { call, manager } = await setup({ idleTakeoverMs: 80 })
    await call("terminal.takeWheel", human("u_iria"), {})
    expect((await call("terminal.write", bridge(), { data: "ls" }).catch((e) => e)).code).toBe(
      "WHEEL_HELD",
    )
    await sleep(120)
    await call("terminal.write", bridge(), { data: "ls" })
    expect(manager.driver("t1")).toMatchObject({ kind: "agent", id: "agent_atlas" })
  })

  it("the wheel is a person's: an agent cannot take or give it back", async () => {
    const { call } = await setup()
    for (const action of ["terminal.takeWheel", "terminal.giveBack"]) {
      expect((await call(action, bridge(), {}).catch((e) => e)).code).toBe("FORBIDDEN")
    }
  })

  it("an agent's terminal.wait returns early when a person takes the wheel (and shows the agent watching meanwhile)", async () => {
    const { call, manager } = await setup()
    await call("terminal.write", bridge(), { data: "yarn test", sendEnter: true })
    const wait = call("terminal.wait", bridge(), {
      until: "text",
      text: "never shows",
      timeoutMs: 5000,
    })
    await sleep(30)
    expect(manager.agentWatchers("t1")).toEqual([
      {
        id: "agent_atlas",
        kind: "agent",
        name: "Atlas",
        avatarUrl: "/static/atlas.png",
        typingAt: null,
      },
    ])
    const started = Date.now()
    await call("terminal.takeWheel", human("u_iria"), {})
    const r = await wait
    expect(Date.now() - started).toBeLessThan(1000)
    expect(r.met).toBe(false)
    expect(r.reason).toBe("driver")
    expect(r.driverChanged).toMatchObject({ kind: "human", id: "u_iria" })
    // The agent stays on as the copilot while Iria drives.
    expect(manager.agentWatchers("t1").map((w) => w.id)).toEqual(["agent_atlas"])
  })

  it("giving the wheel back returns it to the agent; the note reaches it once", async () => {
    const { call, manager } = await setup()
    await call("terminal.write", bridge(), { data: "yarn test", sendEnter: true })
    await call("terminal.takeWheel", human("u_iria"), {})
    const wait = call("terminal.wait", bridge(), {
      until: "text",
      text: "never shows",
      timeoutMs: 5000,
    })
    await sleep(20)
    const back = await call("terminal.giveBack", human("u_iria"), {
      note: "session.test fails on the cache",
    })
    expect(back.driver).toMatchObject({
      kind: "agent",
      id: "agent_atlas",
      note: "session.test fails on the cache",
    })
    const r = await wait
    expect(r.reason).toBe("driver")
    expect(r.handedBack).toEqual({
      by: { id: "u_iria", name: "Iria" },
      note: "session.test fails on the cache",
    })
    const read = await call("terminal.read", bridge(), {})
    expect(read.handedBack).toBeUndefined()
    expect(read.driver).toMatchObject({ kind: "agent" })
    // Only the person at the wheel gives it back.
    expect((await call("terminal.giveBack", human("u_lucia"), {}).catch((e) => e)).code).toBe(
      "NOT_DRIVER",
    )
    expect(manager.driver("t1")?.kind).toBe("agent")
  })

  it("a note left when nobody waits is read once by terminal-read", async () => {
    const { call } = await setup()
    await call("terminal.write", bridge(), { data: "ls" })
    await call("terminal.takeWheel", human("u_iria"), {})
    await call("terminal.giveBack", human("u_iria"), { note: "all yours" })
    expect((await call("terminal.read", bridge(), {})).handedBack).toEqual({
      by: { id: "u_iria", name: "Iria" },
      note: "all yours",
    })
    expect((await call("terminal.read", bridge(), {})).handedBack).toBeUndefined()
  })

  it("two people typing within 2 s are a conflict; one yields to the other", async () => {
    const { call, manager, events } = await setup()
    await call("terminal.input", human("u_iria"), { data: "git" })
    await call("terminal.input", human("u_lucia"), { data: "st" })
    expect(manager.describe("t1")?.conflict?.ids).toEqual(["u_iria", "u_lucia"])
    expect(events.some((e) => e.reason === "conflict" && e.session.conflict)).toBe(true)
    // The yield must name the other person in the conflict.
    expect(
      (await call("terminal.yield", human("u_iria"), { to: "u_owner" }).catch((e) => e)).code,
    ).toBe("INVALID_TARGET")
    const r = await call("terminal.yield", human("u_iria"), { to: "u_lucia" })
    expect(r.driver).toMatchObject({ kind: "human", id: "u_lucia", name: "Lucía" })
    expect(manager.describe("t1")?.conflict).toBeNull()
  })

  it("the driver is written to tmux (it survives a backend restart)", async () => {
    const { call, host } = await setup()
    await call("terminal.takeWheel", human("u_iria"), {})
    const saved = host.options.filter(([, name]: string[]) => name === "@teros_driver").at(-1)
    expect(parseLeaseSnapshot(saved?.[2])?.driver).toMatchObject({
      kind: "human",
      id: "u_iria",
      name: "Iria",
    })
  })
})
