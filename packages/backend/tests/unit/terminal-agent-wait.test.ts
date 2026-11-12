/**
 * Waiting on state (terminal.wait) and session announcements:
 *  - a host session is announced once, complete (persistent, real size) —
 *    the "created" event used to go out before the pane was attached;
 *  - waits only accept what happens after the mark (a prompt sent while the
 *    previous turn's `done` is still current must not end the wait at once);
 *  - quiet / exit / text / needs-login / ended outcomes.
 *
 * The terminal host is a fake with the TermHost surface PtyManager uses; agent
 * states arrive the way tmux delivers them (host.onAttr subscription values).
 */

import { describe, expect, it } from "bun:test"
import { type AgentState, PtyManager, parseAgentState } from "../../src/services/pty-manager"
import { detectMenu } from "../../src/services/terminal/agent-heuristics"
import { makeWaitCheck } from "../../src/services/terminal/agent-wait"

function makePubSub() {
  const broadcasts: Array<{ topic: string; event: Record<string, unknown> }> = []
  return {
    broadcasts,
    broadcastToTopic(topic: string, event: Record<string, unknown>) {
      broadcasts.push({ topic, event })
    },
  }
}

function makeHost(screenLines: string[] = ["$ "]) {
  const sinks = new Map<string, { data(t: string): void; exit(c: number): void }>()
  const host: any = {
    appId: "app_fakehost01",
    container: "teros-term-fake",
    workspaceId: "work_1",
    onAttr: null,
    onPause: null,
    onDisconnect: null,
    screenLines,
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
      }
    },
    bind(_w: string, paneId: string, sink: any) {
      sinks.set(paneId, sink)
    },
    async write() {},
    async resize() {},
    async kill() {},
    async setPaneOption() {},
    async setWindowOption() {},
    async screen() {
      return {
        cols: 80,
        rows: 24,
        lines: host.screenLines,
        cursor: { x: 0, y: 0, visible: true },
        title: "",
        command: "",
        alternateScreen: false,
      }
    },
    emit(text: string) {
      sinks.get("%1")?.data(text)
    },
    exit() {
      sinks.get("%1")?.exit(0)
    },
  }
  return host
}

async function setup() {
  const pubSub = makePubSub()
  const manager = new PtyManager(pubSub as any)
  const changes: Array<{ id: string; reason: string; persistent?: boolean; cols?: number }> = []
  manager.onChange((id, _ws, reason) => {
    const d = manager.describe(id)
    changes.push({ id, reason, persistent: d?.persistent, cols: d?.cols })
  })
  const host = makeHost()
  await manager.createInHost(host, "t1", 100, 30, "work_1", {
    pinned: false,
    title: "Claude Code",
    kind: "claude",
    createdBy: "agent:app_x",
  })
  return { manager, host, changes, pubSub }
}

/** Deliver an agent state the way the tmux subscription does. */
function agentState(host: any, state: string, atMs: number, message = ""): void {
  host.onAttr?.("agent", "%1", `${state}|${atMs}|${message}`)
}

function command(host: any, cmd: string): void {
  host.onAttr?.("cmd", "%1", cmd)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("session announcement", () => {
  it("a host session is announced once, after its pane is attached (persistent, real size)", async () => {
    const { changes } = await setup()
    const created = changes.filter((c) => c.reason === "created")
    expect(created).toEqual([{ id: "t1", reason: "created", persistent: true, cols: 100 }])
  })

  it("reveal() emits a 'reveal' change for an existing session only", async () => {
    const { manager, changes } = await setup()
    expect(manager.reveal("t1")).toBe(true)
    expect(manager.reveal("nope")).toBe(false)
    expect(changes.filter((c) => c.reason === "reveal").map((c) => c.id)).toEqual(["t1"])
  })
})

describe("who typed (follow the agent)", () => {
  it("an agent write is announced (reason 'input') with lastInput; a person's only on change", async () => {
    const { manager, changes } = await setup()
    manager.noteInput("t1", { kind: "agent", id: "agent:app_x" })
    manager.noteInput("t1", { kind: "agent", id: "agent:app_x" })
    // The person typing takes the wheel: announced as "driver" (nothing left to tell).
    expect(manager.noteInput("t1", { kind: "human", id: "u1" })).toBe(false)
    expect(manager.noteInput("t1", { kind: "human", id: "u1" })).toBe(false)
    expect(changes.filter((c) => c.reason === "input").length).toBe(2)
    expect(changes.filter((c) => c.reason === "driver").length).toBe(2)
    expect(manager.describe("t1")?.lastInput).toMatchObject({ kind: "human", id: "u1" })
    expect(manager.describe("t1")?.driver).toMatchObject({ kind: "human", id: "u1" })
  })
})

describe("agent state timestamps", () => {
  it("parses milliseconds (new helper) and seconds (old helper)", () => {
    expect(parseAgentState("done|1792406000123|")?.at.getTime()).toBe(1792406000123)
    expect(parseAgentState("done|1792406000|")?.at.getTime()).toBe(1792406000000)
  })
})

describe("terminal.wait until=turn", () => {
  it("a done that was current before the write does not end the wait; the next turn's done does", async () => {
    const { manager, host } = await setup()
    command(host, "claude")
    agentState(host, "done", Date.now() - 5000) // previous turn
    manager.write("t1", "next prompt\r")
    const mark = manager.lastWriteMark("t1")!
    const wait = manager.waitUntil("t1", makeWaitCheck({ until: "turn", mark }), {
      timeoutMs: 3000,
    })
    await sleep(50)
    agentState(host, "working", Date.now())
    await sleep(50)
    agentState(host, "done", Date.now(), "Claude is waiting for your input")
    expect(await wait).toEqual({ reason: "done", message: "Claude is waiting for your input" })
  })

  it("working→done within one subscription tick (only done seen) still ends the wait", async () => {
    const { manager, host } = await setup()
    command(host, "claude")
    agentState(host, "done", Date.now() - 5000)
    manager.write("t1", "fast prompt\r")
    const mark = manager.lastWriteMark("t1")!
    const wait = manager.waitUntil("t1", makeWaitCheck({ until: "turn", mark }), {
      timeoutMs: 3000,
    })
    await sleep(30)
    agentState(host, "done", Date.now())
    expect((await wait)?.reason).toBe("done")
  })

  it("a stale done delivered after the write (older than the write) is ignored → timeout", async () => {
    const { manager, host } = await setup()
    command(host, "claude")
    manager.write("t1", "prompt\r")
    const mark = manager.lastWriteMark("t1")!
    const wait = manager.waitUntil("t1", makeWaitCheck({ until: "turn", mark }), {
      timeoutMs: 400,
    })
    agentState(host, "done", mark.at - 2000) // the previous turn's Stop, reported late
    expect(await wait).toBeNull()
  })

  it("blocked (permission prompt) ends the wait with the agent's message", async () => {
    const { manager, host } = await setup()
    command(host, "claude")
    manager.write("t1", "edit the file\r")
    const mark = manager.lastWriteMark("t1")!
    const wait = manager.waitUntil("t1", makeWaitCheck({ until: "turn", mark }), {
      timeoutMs: 3000,
    })
    agentState(host, "blocked", Date.now(), "Claude needs your permission to use Bash")
    expect(await wait).toEqual({
      reason: "blocked",
      message: "Claude needs your permission to use Bash",
    })
  })

  it("the agent leaving (back to the shell) ends the wait as exited", async () => {
    const { manager, host } = await setup()
    command(host, "claude")
    manager.write("t1", "/exit\r")
    const mark = manager.lastWriteMark("t1")!
    const wait = manager.waitUntil("t1", makeWaitCheck({ until: "turn", mark }), {
      timeoutMs: 3000,
    })
    await sleep(30)
    command(host, "bash")
    expect((await wait)?.reason).toBe("exited")
  })

  it("the session ending resolves with ended", async () => {
    const { manager, host } = await setup()
    command(host, "claude")
    manager.write("t1", "x\r")
    const mark = manager.lastWriteMark("t1")!
    const wait = manager.waitUntil("t1", makeWaitCheck({ until: "turn", mark }), {
      timeoutMs: 3000,
    })
    await sleep(30)
    host.exit()
    expect(await wait).toEqual({ reason: "ended" })
  })
})

describe("terminal.wait — other conditions", () => {
  it("ready: the agent's SessionStart (idle) after launching it", async () => {
    const { manager, host } = await setup()
    manager.write("t1", "claude\r")
    const mark = manager.lastWriteMark("t1")!
    const wait = manager.waitUntil("t1", makeWaitCheck({ until: "ready", mark }), {
      timeoutMs: 3000,
    })
    await sleep(30)
    command(host, "claude")
    await sleep(30)
    agentState(host, "idle", Date.now())
    expect(await wait).toEqual({ reason: "ready" })
  })

  it("ready: a login screen ends the wait as needs-login", async () => {
    const { manager, host } = await setup()
    manager.write("t1", "claude\r")
    const mark = manager.lastWriteMark("t1")!
    const s = (manager as any).sessions.get("t1")
    const wait = manager.waitUntil("t1", makeWaitCheck({ until: "ready", mark }), {
      timeoutMs: 3000,
    })
    await sleep(30)
    command(host, "claude")
    s.needsAuth = "claude"
    host.emit("Select login method")
    expect(await wait).toEqual({ reason: "needs-login" })
  })


  it("ready: a live agent already working is ready (re-seat of a mid-flight session)", async () => {
    const { manager, host } = await setup()
    manager.write("t1", "claude\r")
    const mark = manager.lastWriteMark("t1")!
    const wait = manager.waitUntil("t1", makeWaitCheck({ until: "ready", mark }), {
      timeoutMs: 3000,
    })
    await sleep(30)
    command(host, "claude")
    await sleep(30)
    // The agent is already working on the task: the session booted fine —
    // waiting for it to go idle again would time out (spurious block).
    agentState(host, "working", Date.now())
    expect(await wait).toEqual({ reason: "ready" })
  })

  it("ready: a stale working state (pre-dating the wait) is NOT ready", async () => {
    const { manager, host } = await setup()
    manager.write("t1", "claude\r")
    const stale = new Date(Date.now() - 60_000)
    ;(manager as any).sessions.get("t1").agentState = { state: "working", at: stale }
    const mark = manager.lastWriteMark("t1")!
    const wait = manager.waitUntil("t1", makeWaitCheck({ until: "ready", mark }), {
      timeoutMs: 500,
    })
    await sleep(600)
    expect(await wait).toBe(null)
  })

  it("quiet: resolves once output stopped for quietMs", async () => {
    const { manager, host } = await setup()
    host.emit("building…\r\n")
    const started = Date.now()
    const out = await manager.waitUntil(
      "t1",
      makeWaitCheck({ until: "quiet", mark: manager.mark("t1")!, quietMs: 300 }),
      { timeoutMs: 3000 },
    )
    expect(out).toEqual({ reason: "quiet" })
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
  })

  it("text: matches the rendered screen once it shows the text", async () => {
    const { manager, host } = await setup()
    const wait = manager.waitUntil(
      "t1",
      makeWaitCheck({ until: "text", mark: manager.mark("t1")!, text: "all tests passed" }),
      { timeoutMs: 3000 },
    )
    await sleep(50)
    host.screenLines = ["$ npm test", "All tests passed", "$ "]
    host.emit("All tests passed\r\n")
    expect(await wait).toEqual({ reason: "matched" })
  })

  it("exit: a pure-bash loop (shell in the foreground, no prompt) is not finished", async () => {
    const { manager, host } = await setup()
    command(host, "bash")
    host.screenLines = ["$ while true; do :; done"]
    manager.write("t1", "while true; do :; done\r")
    host.emit("$ while true; do :; done\r\n")
    const out = await manager.waitUntil(
      "t1",
      makeWaitCheck({ until: "exit", mark: manager.lastWriteMark("t1")! }),
      { timeoutMs: 2500 },
    )
    expect(out).toBeNull()
  })

  it("exit: back at the shell after the foreground command", async () => {
    const { manager, host } = await setup()
    command(host, "bash")
    manager.write("t1", "sleep 1\r")
    const mark = manager.lastWriteMark("t1")!
    const wait = manager.waitUntil("t1", makeWaitCheck({ until: "exit", mark }), {
      timeoutMs: 3000,
    })
    await sleep(30)
    command(host, "sleep")
    await sleep(30)
    command(host, "bash")
    expect(await wait).toEqual({ reason: "exited" })
  })

  it("times out with null", async () => {
    const { manager } = await setup()
    const out = await manager.waitUntil(
      "t1",
      makeWaitCheck({ until: "text", mark: manager.mark("t1")!, text: "never" }),
      { timeoutMs: 200 },
    )
    expect(out).toBeNull()
  })

  it("setAgentState bumps the state sequence (a mark taken before tells it is new)", async () => {
    const { manager } = await setup()
    const before = manager.mark("t1")!
    const state: AgentState = { state: "done", at: new Date(), source: "heuristic" }
    await manager.setAgentState("t1", state)
    expect(manager.mark("t1")!.stateSeq).toBe(before.stateSeq + 1)
  })
})

describe("menus and dialogs without a hook", () => {
  const dialog = [
    " ▐▛███▛█   Claude Code v2.1.304",
    "",
    "────────────────────────────────────────",
    " Make auto mode your default permission mode?",
    "",
    "   Auto mode lets Claude handle permission prompts automatically.",
    "",
    "   ❯ Yes, set auto mode as my default permission mode",
    "     No, keep manual mode",
  ]
  const idle = [
    "❯ This is a smoke test with two lines.",
    "  What is 6*7?",
    "",
    "● FAKE_MODEL_OK: 42",
    "────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────",
    "  ⏸ manual mode on · ? for shortcuts",
  ]

  it("detectMenu: a dialog's highlighted option with its question; never the input box or history", () => {
    expect(detectMenu(dialog)).toBe(
      "Make auto mode your default permission mode? (selected: Yes, set auto mode as my default permission mode)",
    )
    expect(detectMenu(idle)).toBeNull()
    expect(detectMenu(["❯ typed text", "────"])).toBeNull()
  })

  it("a 'done' from the hook while a dialog is up is reported as blocked, with the question", async () => {
    const { manager, host } = await setup()
    command(host, "claude")
    manager.write("t1", "prompt\r")
    const mark = manager.lastWriteMark("t1")!
    host.screenLines = dialog
    const wait = manager.waitUntil("t1", makeWaitCheck({ until: "turn", mark }), {
      timeoutMs: 3000,
    })
    agentState(host, "done", Date.now(), "Claude is waiting for your input")
    expect(await wait).toEqual({
      reason: "blocked",
      message:
        "Make auto mode your default permission mode? (selected: Yes, set auto mode as my default permission mode)",
    })
  })
})

describe("a prompt the agent never started on", () => {
  it("turn → not-started once nothing happened for NOT_STARTED_MS and the screen is quiet", async () => {
    const { manager, host } = await setup()
    command(host, "claude")
    host.emit("❯ prompt\r\n")
    manager.write("t1", "\r")
    const mark = manager.lastWriteMark("t1")!
    let t = mark.at
    const check = makeWaitCheck({ until: "turn", mark, now: () => t })
    const view = () => ({
      ended: false,
      command: "claude",
      agentState: null,
      stateSeq: mark.stateSeq,
      needsAuth: null,
      lastOutputAt: mark.at - 10,
      outputSeq: 1,
      screen: async () => ({
        cols: 80,
        rows: 24,
        lines: ["────", "❯ ", "────"],
        cursor: { x: 0, y: 1, visible: true },
        title: "",
        command: "claude",
        alternateScreen: false,
      }),
    })
    t = mark.at + 5000
    expect(await check(view())).toBeNull()
    t = mark.at + 9000
    expect(await check(view())).toEqual({ reason: "not-started" })
  })
})

describe("driver-abort wrapper (terminal.wait handler semantics)", () => {
  // Mirrors handlers/domains/terminal/index.ts: the wheel-change abort applies
  // to bridge waits EXCEPT until:"ready" — ready is a property of the pane,
  // not of who holds the wheel (regression: CCR sessions died at boot with
  // "did not become ready (driver)" when the revealed window stole the wheel).
  const driverKey = (d: { kind: string; id?: string } | null | undefined) =>
    d ? `${d.kind}:${d.id ?? ""}` : ""

  function wrappedCheck(
    until: string,
    startDriver: string,
    inner: (view: any) => any,
    getDriver: () => any,
  ) {
    if (until === "ready") return inner
    return (view: any) =>
      driverKey(getDriver()) !== startDriver ? { reason: "driver" } : inner(view)
  }

  it('until:"ready" ignores a driver change mid-wait; until:"turn" still aborts with driver', async () => {
    const { manager, host } = await setup()
    command(host, "claude")
    manager.noteInput("t1", { kind: "agent", id: "agent:app_x" })
    const startDriver = driverKey(manager.driver("t1"))
    expect(startDriver).toBe("agent:agent:app_x")

    const mark = manager.lastWriteMark("t1") ?? manager.mark("t1")
    const inner = makeWaitCheck({ until: "ready", mark })

    // A person grabs the wheel while the agent waits for ready.
    manager.noteInput("t1", { kind: "human", id: "u1" })
    expect(driverKey(manager.driver("t1"))).not.toBe(startDriver)

    const readyCheck = wrappedCheck("ready", startDriver, inner, () => manager.driver("t1"))
    const turnCheck = wrappedCheck("turn", startDriver, inner, () => manager.driver("t1"))

    const view = {
      ended: false,
      command: "claude",
      agentState: { state: "done", at: new Date(mark.at + 10), source: "hook" },
      stateSeq: mark.stateSeq + 1,
      needsAuth: null,
      lastOutputAt: mark.at + 10,
      outputSeq: 2,
      screen: async () => ({ lines: ["❯ "] }),
    }
    // ready: driver change is irrelevant → inner verdict (ready, not driver)
    const readyOutcome = await readyCheck(view)
    expect(readyOutcome).not.toEqual({ reason: "driver" })
    // turn: driver change aborts with reason "driver"
    expect(await turnCheck(view)).toEqual({ reason: "driver" })
  })
})
