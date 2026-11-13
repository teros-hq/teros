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
    key: "app_fakehost01",
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

function makeDb(gone: Set<string>) {
  return {
    collection: (name: string) => ({
      findOne: async (filter: any) =>
        name === "workspaces"
          ? { workspaceId: filter.workspaceId, ownerId: "u_owner", status: "active" }
          : name === "workspace_members" && !gone.has(filter.userId)
            ? { workspaceId: filter.workspaceId, userId: filter.userId, role: "write" }
            : null,
    }),
  } as any
}

async function setup(
  lease: { idleTakeoverMs?: number; conflictWindowMs?: number } = {},
  createdBy = "agent:app_terminal",
  space?: "personal" | "shared",
) {
  const manager = new PtyManager({ broadcastToTopic() {} } as any, { lease })
  const host = makeHost()
  const gone = new Set<string>()
  await manager.createInHost(host, "t1", 100, 30, "work_1", {
    title: "Tests",
    kind: "claude",
    createdBy,
    space,
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
    mcaService: { getApp: async (appId: string) => ({ appId, ownerId: "work_1" }) } as any,
    mcaManager: {} as any,
    db: makeDb(gone),
    identities: {
      human: async (userId: string) => ({
        kind: "human",
        id: userId,
        name: NAMES[userId] ?? userId,
        avatarUrl: `/avatars/${userId}.png`,
      }),
      agent: async (_ctx: unknown, agentId?: unknown) =>
        agentId === "agent_rex"
          ? { kind: "agent", id: "agent_rex", name: "Rex", avatarUrl: "/static/rex.png" }
          : { kind: "agent", id: "agent_atlas", name: "Atlas", avatarUrl: "/static/atlas.png" },
    },
  })
  const call = (action: string, ctx: WsHandlerContext, data: Record<string, unknown>) =>
    handlers.get(action)!(ctx, { terminalId: "t1", ...data })
  return { manager, host, handlers, call, events, gone }
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
      expect(err.message).toStartWith("Iria is typing in this session. Ask for control with terminal-request-control")
    }
  })

  it("viewing is read-only: while an agent holds the wheel a person's keys are refused until they take it", async () => {
    const { call, manager } = await setup()
    await call("terminal.write", bridge(), { data: "ls", sendEnter: true })
    expect(manager.driver("t1")?.kind).toBe("agent")
    for (const action of ["terminal.write", "terminal.input"]) {
      const err = await call(action, human("u_iria"), { data: "x" }).catch((e) => e)
      expect(err.code).toBe("WHEEL_HELD")
      expect(err.message).toContain("Atlas is typing in this session")
      expect(err.message).toContain('Switch "Agent off" to type')
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
    const again = await call("terminal.giveBack", human("u_lucia"), {})
    expect(again).toMatchObject({ ok: true, driver: { kind: "agent", id: "agent_atlas" } })
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

  it("the note reaches the agent on its next write or wheel request too (once)", async () => {
    for (const next of ["terminal.write", "terminal.requestWheel"]) {
      const { call } = await setup()
      await call("terminal.write", bridge(), { data: "ls" })
      await call("terminal.takeWheel", human("u_iria"), {})
      await call("terminal.giveBack", human("u_iria"), { note: "use pytest" })
      const r = await call(next, bridge(), { data: "pytest", timeoutMs: 1000 })
      expect(r.handedBack).toEqual({ by: { id: "u_iria", name: "Iria" }, note: "use pytest" })
      expect((await call("terminal.read", bridge(), {})).handedBack).toBeUndefined()
    }
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

describe("terminal crew: an agent asks for the wheel of a person's session", () => {
  const person = async () => {
    const made = await setup({ idleTakeoverMs: 80 }, "u_iria")
    made.manager.setAgentControl("t1", { kind: "human", id: "u_iria", name: "Iria" }, true)
    return made
  }

  it("[TW-AC-10] in a session a person opened with the flag off, the agent reaches nothing, however idle the person is", async () => {
    const { call, manager } = await setup({ idleTakeoverMs: 80 }, "u_iria")
    const refused = await call("terminal.write", bridge(), { data: "ls" }).catch((e) => e)
    expect(refused.code).toBe("FORBIDDEN_TERMINAL")
    await call("terminal.takeWheel", human("u_iria"), {})
    await sleep(120)
    expect((await call("terminal.write", bridge(), { data: "ls" }).catch((e) => e)).code).toBe(
      "FORBIDDEN_TERMINAL",
    )
    expect(manager.driver("t1")).toMatchObject({ kind: "human", id: "u_iria" })
  })

  it("request → approve: the agent drives at once and its write goes through", async () => {
    const { call, manager, events } = await person()
    await call("terminal.takeWheel", human("u_iria"), {})
    const asked = call("terminal.requestWheel", bridge(), {
      reason: "run the tests",
      timeoutMs: 5000,
    })
    await sleep(30)
    expect(manager.describe("t1")?.wheelRequest).toMatchObject({
      agent: { id: "agent_atlas", name: "Atlas" },
      reason: "run the tests",
    })
    expect(events.some((e) => e.reason === "wheel_request" && e.session.wheelRequest)).toBe(true)
    const answer = await call("terminal.answerWheel", human("u_iria"), { approve: true })
    expect(answer.driver).toMatchObject({ kind: "agent", id: "agent_atlas" })
    expect(await asked).toMatchObject({
      outcome: "approved",
      driver: { kind: "agent" },
      answeredBy: { id: "u_iria", name: "Iria" },
    })
    expect(manager.describe("t1")?.wheelRequest).toBeNull()
    await call("terminal.write", bridge(), { data: "yarn test", sendEnter: true })
    expect(manager.driver("t1")).toMatchObject({ kind: "agent", id: "agent_atlas" })
  })

  it("request → deny: denied, the request goes and the agent still can't type", async () => {
    const { call, manager } = await person()
    await call("terminal.takeWheel", human("u_iria"), {})
    const asked = call("terminal.requestWheel", bridge(), { timeoutMs: 5000 })
    await sleep(30)
    await call("terminal.answerWheel", human("u_iria"), { approve: false })
    expect(await asked).toMatchObject({ outcome: "denied" })
    expect(manager.describe("t1")?.wheelRequest).toBeNull()
    expect((await call("terminal.write", bridge(), { data: "ls" }).catch((e) => e)).code).toBe(
      "WHEEL_HELD",
    )
  })

  it("nobody answers in time: pending, and the request stays on screen", async () => {
    const { call, manager } = await person()
    await call("terminal.takeWheel", human("u_iria"), {})
    expect(await call("terminal.requestWheel", bridge(), { timeoutMs: 50 })).toMatchObject({
      outcome: "pending",
    })
    expect(manager.describe("t1")?.wheelRequest).toMatchObject({ agent: { id: "agent_atlas" } })
  })

  it("a free wheel in the agent's own session is granted at once", async () => {
    const { call, manager } = await setup()
    expect(await call("terminal.requestWheel", bridge(), {})).toMatchObject({ outcome: "granted" })
    expect(manager.driver("t1")).toMatchObject({ kind: "agent", id: "agent_atlas" })
  })

  it("a second agent asking while another's request is pending is told who asked first; the first request stays", async () => {
    const { call, manager } = await person()
    await call("terminal.takeWheel", human("u_iria"), {})
    const atlas = call("terminal.requestWheel", bridge(), { reason: "atlas wants", timeoutMs: 5000 })
    await sleep(30)
    const rex = await call("terminal.requestWheel", bridge(), {
      agentId: "agent_rex",
      reason: "rex wants",
      timeoutMs: 5000,
    })
    expect(rex).toMatchObject({ outcome: "busy", askedBy: { id: "agent_atlas", name: "Atlas" } })
    expect(manager.describe("t1")?.wheelRequest).toMatchObject({
      agent: { id: "agent_atlas" },
      reason: "atlas wants",
    })
    await call("terminal.answerWheel", human("u_iria"), { approve: true })
    expect(await atlas).toMatchObject({ outcome: "approved" })
    expect(manager.driver("t1")).toMatchObject({ kind: "agent", id: "agent_atlas" })
  })

  it("a waiting request ends as approved, and leaves the screen, when the person gives the wheel back instead of answering", async () => {
    const { call, manager } = await setup()
    await call("terminal.write", bridge(), { data: "ls" })
    await call("terminal.takeWheel", human("u_iria"), {})
    const asked = call("terminal.requestWheel", bridge(), { timeoutMs: 5000 })
    await sleep(30)
    await call("terminal.giveBack", human("u_iria"), {})
    expect(await asked).toMatchObject({ outcome: "approved", driver: { kind: "agent", id: "agent_atlas" } })
    expect(manager.describe("t1")?.wheelRequest).toBeNull()
  })

  it("an answer reaches only the agent whose request it answered", async () => {
    const { call, manager } = await person()
    await call("terminal.takeWheel", human("u_iria"), {})
    const atlas = call("terminal.requestWheel", bridge(), { timeoutMs: 5000 })
    await sleep(30)
    await call("terminal.answerWheel", human("u_iria"), { approve: false })
    expect(await atlas).toMatchObject({ outcome: "denied" })
    const rex = call("terminal.requestWheel", bridge(), { agentId: "agent_rex", timeoutMs: 300 })
    const atlasAgain = call("terminal.requestWheel", bridge(), { timeoutMs: 300 })
    expect(await atlasAgain).toMatchObject({ outcome: "busy", askedBy: { id: "agent_rex" } })
    await call("terminal.answerWheel", human("u_iria"), { approve: true })
    expect(await rex).toMatchObject({ outcome: "approved" })
    expect(manager.driver("t1")).toMatchObject({ kind: "agent", id: "agent_rex" })
  })

  it("an answer from a card of an earlier request never hands the wheel to the agent asking now", async () => {
    const { call, manager } = await person()
    await call("terminal.takeWheel", human("u_iria"), {})
    const atlas = call("terminal.requestWheel", bridge(), { timeoutMs: 5000 })
    await sleep(30)
    await call("terminal.answerWheel", human("u_iria"), { approve: false, agentId: "agent_atlas" })
    expect(await atlas).toMatchObject({ outcome: "denied" })
    const rex = call("terminal.requestWheel", bridge(), { agentId: "agent_rex", timeoutMs: 5000 })
    await sleep(30)
    const stale = await call("terminal.answerWheel", human("u_iria"), {
      approve: true,
      agentId: "agent_atlas",
    }).catch((e) => e)
    expect(stale.code).toBe("STALE_WHEEL_REQUEST")
    expect(manager.driver("t1")).toMatchObject({ kind: "human", id: "u_iria" })
    expect(manager.describe("t1")?.wheelRequest).toMatchObject({ agent: { id: "agent_rex" } })
    await call("terminal.answerWheel", human("u_iria"), { approve: true, agentId: "agent_rex" })
    expect(await rex).toMatchObject({ outcome: "approved" })
  })

  it("while a person drives, only they answer an agent's wheel request; another member is told who can", async () => {
    const { call, manager } = await setup({ idleTakeoverMs: 80 }, "u_iria", "shared")
    manager.setAgentControl("t1", { kind: "human", id: "u_iria", name: "Iria" }, true)
    await call("terminal.takeWheel", human("u_iria"), {})
    const asked = call("terminal.requestWheel", bridge(), { timeoutMs: 5000 })
    await sleep(30)
    const err = await call("terminal.answerWheel", human("u_lucia"), { approve: true }).catch((e) => e)
    expect(err.code).toBe("NOT_YOUR_WHEEL")
    expect(err.message).toContain("Iria")
    expect(manager.describe("t1")?.wheelRequest).toMatchObject({ agent: { id: "agent_atlas" } })
    expect(manager.driver("t1")).toMatchObject({ kind: "human", id: "u_iria" })
    await call("terminal.answerWheel", human("u_iria"), { approve: true })
    expect(await asked).toMatchObject({ outcome: "approved", answeredBy: { id: "u_iria" } })
  })

  it("only agents request and only people answer", async () => {
    const { call } = await person()
    expect((await call("terminal.requestWheel", human("u_iria"), {}).catch((e) => e)).code).toBe(
      "FORBIDDEN",
    )
    expect(
      (await call("terminal.answerWheel", bridge(), { approve: true }).catch((e) => e)).code,
    ).toBe("FORBIDDEN")
    expect(
      (await call("terminal.answerWheel", human("u_iria"), { approve: true }).catch((e) => e)).code,
    ).toBe("NO_WHEEL_REQUEST")
  })
})

describe("terminal crew: an agent lets go of the wheel", () => {
  it("the agent at the wheel releases it: nobody drives, everyone sees it", async () => {
    const { call, manager, events } = await setup()
    await call("terminal.write", bridge(), { data: "ls", sendEnter: true })
    events.length = 0
    const r = await call("terminal.releaseWheel", bridge(), {})
    expect(r).toMatchObject({ released: true, driver: { kind: "none" } })
    expect(manager.driver("t1")).toMatchObject({ kind: "none" })
    expect(events.some((e) => e.reason === "driver" && e.session.driver.kind === "none")).toBe(true)
  })

  it("an agent that doesn't drive changes nothing and hears who does", async () => {
    const { call, manager } = await setup()
    await call("terminal.takeWheel", human("u_iria"), {})
    const r = await call("terminal.releaseWheel", bridge(), {})
    expect(r).toMatchObject({ released: false, driver: { kind: "human", id: "u_iria" } })
    expect(manager.driver("t1")).toMatchObject({ kind: "human", id: "u_iria" })
  })

  it("in a person's session with the flag on, an agent that let go may type again later: the flag stays on", async () => {
    const { call, manager } = await setup({}, "u_iria")
    await call("terminal.agentControl", human("u_iria"), { enabled: true })
    await call("terminal.write", bridge(), { data: "ls" })
    await call("terminal.releaseWheel", bridge(), {})
    expect(manager.describe("t1")).toMatchObject({ agentControl: true, driver: { kind: "none" } })
    await call("terminal.write", bridge(), { data: "ls" })
    expect(manager.driver("t1")).toMatchObject({ kind: "agent", id: "agent_atlas" })
  })

  it("after an agent lets go, the person who takes the wheel and gives it back hands it to that agent, with the note", async () => {
    const { call, manager } = await setup({}, "u_iria")
    await call("terminal.agentControl", human("u_iria"), { enabled: true })
    await call("terminal.write", bridge(), { data: "ls" })
    await call("terminal.releaseWheel", bridge(), {})
    await call("terminal.takeWheel", human("u_iria"), {})
    const back = await call("terminal.giveBack", human("u_iria"), { note: "carry on" })
    expect(back.driver).toMatchObject({ kind: "agent", id: "agent_atlas", note: "carry on" })
    expect(manager.driver("t1")).toMatchObject({ kind: "agent", id: "agent_atlas" })
    expect((await call("terminal.read", bridge(), {})).handedBack).toEqual({
      by: { id: "u_iria", name: "Iria" },
      note: "carry on",
    })
    await call("terminal.write", bridge(), { data: "ls" })
  })

  it("the session says which agent a give-back goes to (priorAgent), so the window's button names it after a reload", async () => {
    const { call, manager } = await setup({}, "u_iria")
    await call("terminal.agentControl", human("u_iria"), { enabled: true })
    await call("terminal.write", bridge(), { data: "ls" })
    expect(manager.describe("t1")?.priorAgent).toBeNull()
    await call("terminal.releaseWheel", bridge(), {})
    expect(manager.describe("t1")?.priorAgent).toMatchObject({ id: "agent_atlas", name: "Atlas" })
    await call("terminal.takeWheel", human("u_iria"), {})
    expect(manager.describe("t1")?.priorAgent).toMatchObject({ id: "agent_atlas" })
    await call("terminal.giveBack", human("u_iria"), {})
    expect(manager.describe("t1")?.priorAgent).toBeNull()
  })

  it("only agents release; people give the wheel back", async () => {
    const { call } = await setup()
    expect((await call("terminal.releaseWheel", human("u_iria"), {}).catch((e) => e)).code).toBe(
      "FORBIDDEN",
    )
  })
})
