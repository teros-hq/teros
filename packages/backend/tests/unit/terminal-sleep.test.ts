/**
 * Terminal sessions sleep instead of dying (pty-manager.ts lifecycle):
 *  - awake → frozen: every session of a host idle FREEZE_AFTER (no input,
 *    output, viewer or waiter) → docker pause of the host;
 *  - frozen → sleeping: HIBERNATE_AFTER frozen → each session saved (history,
 *    cwd, what ran, Claude Code's session id), host container removed, the
 *    sessions stay listed;
 *  - wake on use: ensureAwake() unpauses a frozen host, or brings a sleeping
 *    session back through the SessionWaker (in place: same object, buffer,
 *    listeners), once for concurrent callers;
 *  - boot: saved sessions are listed again; a host found paused is adopted
 *    (not mistaken for a dead one) and keeps its frozen clock;
 *  - the pieces the terminal domain uses to resume (resumePlan, claudeResumeLine).
 *
 * The clock is the sweep's `now` argument; hosts, the host manager and the
 * store are fakes with the surface PtyManager uses.
 */

import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { parseLeaseSnapshot } from "../../src/services/terminal/driver-lease"
import {
  boundHistory,
  PtyManager,
  type SleepRecord,
  type SleepStore,
  sessionIsIdle,
} from "../../src/services/pty-manager"
import {
  AGENT_STATE_SCRIPT,
  claudeResumeLine,
  resumeHistoryScript,
  resumePlan,
  resumeWindowCommand,
  wakeCwdOf,
} from "../../src/services/terminal/agent-hooks"

const FREEZE = 15 * 60_000
const HIBERNATE = 2 * 3600_000

function makePubSub() {
  const broadcasts: Array<{ topic: string; event: Record<string, unknown> }> = []
  return {
    broadcasts,
    broadcastToTopic(topic: string, event: Record<string, unknown>) {
      broadcasts.push({ topic, event })
    },
  }
}

interface FakePane {
  cwd: string
  command: string
  pid: number
  agentSession: string
  history: string[]
}

function makeHost(appId = "app_fakehost01") {
  const sinks = new Map<string, { data(t: string): void; exit(c: number): void }>()
  const panes = new Map<string, FakePane>()
  const windows: any[] = []
  let n = 0
  const host: any = {
    appId,
    container: `teros-term-fake-${appId}`,
    workspaceId: "work_1",
    onAttr: null,
    onPause: null,
    onDisconnect: null,
    onUnpause: null,
    paused: false,
    pausedAt: null as number | null,
    calls: {
      pause: [] as number[],
      unpause: 0,
      created: [] as any[],
      options: [] as Array<[string, string, string]>,
    },
    panes,
    windows,
    pausedOption: "",
    async pause(at: number) {
      host.calls.pause.push(at)
      host.paused = true
      host.pausedAt = at
    },
    async unpause() {
      if (!host.paused) return
      host.calls.unpause++
      host.paused = false
      host.pausedAt = null
      host.onUnpause?.(3)
    },
    async createWindow(meta: any, opts: any) {
      n++
      const win = {
        ...meta,
        windowId: `@${n}`,
        paneId: `%${n}`,
        panePid: 100 + n,
        cols: opts.cols,
        rows: opts.rows,
        activityAt: Date.now(),
        command: "",
        agentState: "",
      }
      host.calls.created.push({ meta, opts })
      windows.push(win)
      panes.set(win.paneId, {
        cwd: opts.cwd ?? "/workspace",
        command: "bash",
        pid: win.panePid,
        agentSession: "",
        history: [],
      })
      return win
    },
    async listWindows() {
      if (host.paused) await host.unpause() // ensureControl unpauses
      return windows
    },
    async serverOption() {
      return host.pausedOption
    },
    bind(_w: string, paneId: string, sink: any) {
      sinks.set(paneId, sink)
    },
    async write() {},
    async resize() {},
    async kill() {},
    async setPaneOption() {},
    async setWindowOption(windowId: string, name: string, value: string) {
      host.calls.options.push([windowId, name, value])
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
    async paneInfo(paneId: string) {
      const p = panes.get(paneId)!
      return { cwd: p.cwd, command: p.command, pid: p.pid, agentSession: p.agentSession }
    },
    async plainHistory(paneId: string) {
      return [...panes.get(paneId)!.history, "", ""]
    },
    async foregroundArgs(pids: number[]) {
      const out = new Map<number, string>()
      for (const p of panes.values())
        if (pids.includes(p.pid) && p.command === "node") out.set(p.pid, "npm run dev")
      return out
    },
    emit(paneId: string, text: string) {
      sinks.get(paneId)?.data(text)
    },
  }
  return host
}

function makeTermHosts(first: any) {
  const hosts = new Map<string, any>([[first.appId, first]])
  const removed: Array<[string, string]> = []
  return {
    stackId: "stack_test",
    removed,
    hosts,
    all: () => [...hosts.values()],
    containerName: (appId: string) => `teros-term-fake-${appId}`,
    async remove(appId: string, why: string) {
      removed.push([appId, why])
      hosts.delete(appId)
    },
    async running(appId: string) {
      return hosts.get(appId) ?? null
    },
    async ensure(appId: string) {
      const host = hosts.get(appId) ?? makeHost(appId)
      hosts.set(appId, host)
      return host
    },
    async discover() {
      return [...hosts.values()]
    },
  }
}

function makeStore(initial: SleepRecord[] = []) {
  const docs = new Map(initial.map((r) => [r.terminalId, r]))
  const store: SleepStore & { docs: Map<string, SleepRecord>; removed: string[] } = {
    docs,
    removed: [],
    async load(stackId) {
      return [...docs.values()].filter((r) => r.stackId === stackId)
    },
    async save(r) {
      docs.set(r.terminalId, { ...r })
    },
    async remove(id) {
      store.removed.push(id)
      docs.delete(id)
    },
    async rename(id, title) {
      const r = docs.get(id)
      if (r) r.title = title
    },
    async setLease(id, lease) {
      const r = docs.get(id)
      if (r) r.lease = lease
    },
  }
  return store
}

const META = (title: string, kind = "shell") => ({
  title,
  kind,
  createdBy: "u1",
  appId: "app_fakehost01",
})

async function setup() {
  const pubSub = makePubSub()
  const manager = new PtyManager(pubSub as any, {
    freezeAfterMs: FREEZE,
    hibernateAfterMs: HIBERNATE,
  })
  const host = makeHost()
  const termHosts = makeTermHosts(host)
  const store = makeStore()
  manager.useTermHosts(termHosts as any)
  manager.useSleepStore(store)
  const changes: Array<{ id: string; reason: string; lifecycle?: string }> = []
  manager.onChange((id, _ws, reason) =>
    changes.push({ id, reason, lifecycle: manager.describe(id)?.lifecycle }),
  )
  await manager.createInHost(host, "t_shell", 100, 30, "work_1", META("deploy logs"))
  await manager.createInHost(host, "t_claude", 100, 30, "work_1", META("Claude Code", "claude"))
  await manager.createInHost(host, "t_dev", 100, 30, "work_1", META("dev server"))
  host.emit("%1", "$ make deploy\r\ndeployed v42\r\n")
  host.panes.get("%1").history = ["$ make deploy", "deployed v42", "$ "]
  host.panes.get("%1").cwd = "/workspace/app"
  Object.assign(host.panes.get("%2"), { command: "claude", agentSession: "sess-1234-abcd" })
  host.emit("%2", "> fix the login bug\r\n● Done.\r\n")
  host.panes.get("%2").history = ["> fix the login bug", "● Done."]
  host.panes.get("%3").command = "node"
  return { manager, host, termHosts, store, changes, pubSub }
}

/** Everyone idle since `ago` ms before `now`. */
function idleSince(manager: PtyManager, at: number): void {
  for (const s of (manager as any).sessions.values()) s.lastActivity = new Date(at)
}

const sweep = (manager: PtyManager, now: number) => (manager as any)._lifecycleSweep(now)
const flush = () => new Promise((r) => setTimeout(r, 0))

describe("awake → frozen", () => {
  it("freezes the host once EVERY session of it has been idle FREEZE_AFTER", async () => {
    const { manager, host, changes } = await setup()
    const t0 = Date.now()
    idleSince(manager, t0)
    sweep(manager, t0 + FREEZE - 1000)
    await flush()
    expect(host.calls.pause).toEqual([])
    sweep(manager, t0 + FREEZE)
    await flush()
    expect(host.calls.pause).toEqual([t0 + FREEZE])
    expect(manager.list().map((s) => s.lifecycle)).toEqual(["frozen", "frozen", "frozen"])
    expect(changes.filter((c) => c.reason === "frozen")).toHaveLength(3)
    expect(manager.lifecycleStats()).toMatchObject({
      sessions: { awake: 0, frozen: 3, sleeping: 0 },
      hosts: { awake: 0, frozen: 1 },
      freezes: 1,
    })
  })

  it("one busy session keeps the whole host awake (output, a viewer, a waiter)", async () => {
    const { manager, host } = await setup()
    const t0 = Date.now()
    const cases: Array<() => () => void> = [
      () => {
        idleSince(manager, t0)
        ;(manager as any).sessions.get("t_dev").lastActivity = new Date(t0 + FREEZE)
        return () => {}
      },
      () => {
        idleSince(manager, t0)
        return manager.onOutput("t_shell", () => {})
      },
      () => {
        idleSince(manager, t0)
        manager.waitFor("t_claude", /never/, { timeoutMs: 60_000 }).catch(() => {})
        idleSince(manager, t0)
        const s = (manager as any).sessions.get("t_claude")
        return () => {
          for (const w of s.waiters) clearTimeout(w.timer)
          s.waiters.clear()
        }
      },
    ]
    for (const busy of cases) {
      const undo = busy()
      sweep(manager, t0 + FREEZE + 1000)
      await flush()
      expect(host.calls.pause).toEqual([])
      undo()
    }
  })

  it("output from a session counts as activity (a coding agent mid-turn is not idle)", async () => {
    const { manager, host } = await setup()
    const t0 = Date.now() - FREEZE - 5000
    idleSince(manager, t0)
    host.emit("%2", "✻ Thinking…")
    sweep(manager, Date.now())
    await flush()
    expect(host.calls.pause).toEqual([])
  })

  it("frozen → awake on use: ensureAwake unpauses, says so, and counts the wake", async () => {
    const { manager, host, changes } = await setup()
    const t0 = Date.now()
    idleSince(manager, t0)
    sweep(manager, t0 + FREEZE)
    await flush()
    const woke = await manager.ensureAwake("t_shell", { userId: "u1" })
    expect(woke?.from).toBe("frozen")
    expect(host.calls.unpause).toBe(1)
    expect(manager.list().every((s) => s.lifecycle === "awake")).toBe(true)
    expect(changes.filter((c) => c.reason === "awake")).toHaveLength(3)
    expect(manager.lifecycleStats().wakes.frozen.count).toBe(1)
    // Awake already: nothing to do.
    expect(await manager.ensureAwake("t_shell", { userId: "u1" })).toBeNull()
  })
})

describe("frozen → sleeping (hibernation)", () => {
  async function hibernated() {
    const ctx = await setup()
    const t0 = Date.now()
    idleSince(ctx.manager, t0)
    sweep(ctx.manager, t0 + FREEZE)
    await flush()
    sweep(ctx.manager, t0 + FREEZE + HIBERNATE - 1000)
    await flush()
    expect(ctx.termHosts.removed).toEqual([])
    sweep(ctx.manager, t0 + FREEZE + HIBERNATE)
    await (ctx.manager as any).hibernating.get("app_fakehost01")
    return ctx
  }

  it("saves every session, removes the container, keeps the sessions listed as sleeping", async () => {
    const { manager, store, termHosts, changes, pubSub } = await hibernated()
    expect(termHosts.removed).toEqual([["app_fakehost01", "hibernated"]])
    const list = manager.list()
    expect(list.map((s) => [s.terminalId, s.lifecycle])).toEqual([
      ["t_shell", "sleeping"],
      ["t_claude", "sleeping"],
      ["t_dev", "sleeping"],
    ])
    expect(list[0]).toMatchObject({ persistent: true, title: "deploy logs" })
    expect(list[0].sleptAt).toBeInstanceOf(Date)
    expect(store.docs.get("t_shell")).toMatchObject({
      stackId: "stack_test",
      workspaceId: "work_1",
      appId: "app_fakehost01",
      cwd: "/workspace/app",
      command: "bash",
      foreground: "",
      history: "$ make deploy\ndeployed v42\n$ ",
    })
    expect(store.docs.get("t_claude")).toMatchObject({
      command: "claude",
      agentSession: "sess-1234-abcd",
      kind: "claude",
    })
    expect(store.docs.get("t_dev")).toMatchObject({ command: "node", foreground: "npm run dev" })
    // Not an end: no exit event, nobody is told the session is gone.
    expect(changes.filter((c) => c.reason === "exit")).toEqual([])
    expect(changes.filter((c) => c.reason === "sleep")).toHaveLength(3)
    expect(pubSub.broadcasts.filter((b) => b.event.type === "terminal_exit")).toEqual([])
    expect(manager.lifecycleStats()).toMatchObject({
      sessions: { awake: 0, frozen: 0, sleeping: 3 },
      hosts: { awake: 0, frozen: 0 },
      hibernations: 1,
    })
    // terminal-read still answers from what was there.
    expect(manager.read("t_shell").lines).toContain("deployed v42")
  })

  it("a viewer attaching while the panes are read calls the hibernation off; mere output doesn't", async () => {
    const { manager, host, termHosts, store } = await setup()
    const t0 = Date.now()
    idleSince(manager, t0)
    sweep(manager, t0 + FREEZE)
    await flush()
    const read = host.plainHistory
    let detach = () => {}
    host.plainHistory = async (paneId: string) => {
      host.emit("%2", "\x1b[?25l repaint after unpause") // a TUI redrawing: not a use
      if (paneId === "%3") detach = manager.onOutput("t_shell", () => {})
      return read(paneId)
    }
    sweep(manager, t0 + FREEZE + HIBERNATE)
    await (manager as any).hibernating.get("app_fakehost01")
    expect(termHosts.removed).toEqual([])
    expect(store.docs.size).toBe(0)
    expect(manager.list().every((s) => s.lifecycle === "awake")).toBe(true)
    // Without the viewer, the same repaint doesn't stop it.
    detach()
    host.plainHistory = async (paneId: string) => {
      host.emit("%2", "\x1b[?25l repaint after unpause")
      return read(paneId)
    }
    idleSince(manager, t0)
    sweep(manager, t0 + 2 * FREEZE)
    await flush()
    sweep(manager, t0 + 2 * FREEZE + HIBERNATE)
    await (manager as any).hibernating.get("app_fakehost01")
    expect(termHosts.removed).toEqual([["app_fakehost01", "hibernated"]])
  })

  it("wake from sleep: the waker recreates it IN PLACE (same session, buffer, viewers), once", async () => {
    const { manager, store, changes } = await hibernated()
    const before = (manager as any).sessions.get("t_claude")
    let calls = 0
    manager.useWaker(async (record, by) => {
      calls++
      expect(by.userId).toBe("u2")
      expect(record).toMatchObject({ terminalId: "t_claude", agentSession: "sess-1234-abcd" })
      const host = await (manager.termHostManager as any).ensure(record.appId)
      await manager.createInHost(
        host,
        record.terminalId,
        record.cols,
        record.rows,
        record.workspaceId,
        { title: record.title, kind: record.kind, createdBy: record.createdBy },
        {
          cwd: record.cwd,
          resumed: { agent: "claude", notRestored: null, message: "Claude Code is back." },
        },
      )
    })
    const [a, b] = await Promise.all([
      manager.ensureAwake("t_claude", { userId: "u2" }),
      manager.ensureAwake("t_claude", { userId: "u2" }),
    ])
    expect(calls).toBe(1)
    expect(a?.from).toBe("sleeping")
    expect(b).toEqual(a)
    expect((manager as any).sessions.get("t_claude")).toBe(before)
    const info = manager.describe("t_claude")!
    expect(info.lifecycle).toBe("awake")
    expect(info.sleptAt).toBeNull()
    expect(info.resumed).toMatchObject({ agent: "claude", message: "Claude Code is back." })
    expect(info.resumed?.sleptAt).toBeInstanceOf(Date)
    expect(store.removed).toEqual(["t_claude"])
    expect(store.docs.has("t_shell")).toBe(true) // the others sleep on
    expect(changes.filter((c) => c.reason === "wake").map((c) => c.id)).toEqual(["t_claude"])
    expect(manager.lifecycleStats().wakes.sleeping.count).toBe(1)
    // The old buffer is still there for terminal-read cursors.
    expect(manager.read("t_claude").lines).toContain("● Done.")
  })

  it("a wake that doesn't bring the session back fails loudly and leaves it asleep", async () => {
    const { manager } = await hibernated()
    manager.useWaker(async () => {})
    await expect(manager.ensureAwake("t_shell", { userId: "u1" })).rejects.toThrow("did not wake")
    expect(manager.describe("t_shell")?.lifecycle).toBe("sleeping")
  })

  it("closing a sleeping session deletes its saved copy and ends it", async () => {
    const { manager, store, pubSub } = await hibernated()
    manager.destroy("t_dev")
    await flush()
    expect(manager.has("t_dev")).toBe(false)
    expect(store.docs.has("t_dev")).toBe(false)
    expect(pubSub.broadcasts.filter((b) => b.event.type === "terminal_exit")).toHaveLength(1)
  })

  it("the driver sleeps with the session, can change while it sleeps, and wakes with it", async () => {
    const ctx = await setup()
    ctx.manager.noteInput(
      "t_claude",
      { kind: "agent", id: "agent:app_x" },
      { kind: "agent", id: "agent_atlas", name: "Atlas" },
    )
    ctx.manager.takeWheel("t_claude", { kind: "human", id: "u1", name: "Iria" })
    const t0 = Date.now()
    idleSince(ctx.manager, t0)
    sweep(ctx.manager, t0 + FREEZE)
    await flush()
    sweep(ctx.manager, t0 + FREEZE + HIBERNATE)
    await (ctx.manager as any).hibernating.get("app_fakehost01")
    const { manager, store } = ctx
    expect(parseLeaseSnapshot(store.docs.get("t_claude")?.lease)).toMatchObject({
      driver: { kind: "human", id: "u1", name: "Iria" },
      priorAgent: { id: "agent_atlas" },
    })
    // Given back while asleep: the saved copy follows.
    manager.giveBack("t_claude", { kind: "human", id: "u1", name: "Iria" }, "your turn")
    await flush()
    expect(parseLeaseSnapshot(store.docs.get("t_claude")?.lease)?.driver).toMatchObject({
      kind: "agent",
      id: "agent_atlas",
      note: "your turn",
    })
    manager.useWaker(async (record) => {
      const h = await (manager.termHostManager as any).ensure(record.appId)
      await manager.createInHost(
        h,
        record.terminalId,
        record.cols,
        record.rows,
        record.workspaceId,
        {
          title: record.title,
          kind: record.kind,
          createdBy: record.createdBy,
        },
      )
    })
    await manager.ensureAwake("t_claude", { userId: "u1" })
    expect(manager.describe("t_claude")?.driver).toMatchObject({ kind: "agent", id: "agent_atlas" })
    // The new window carries it on (next backend restart), and the note is still unread.
    const saved = (manager as any).sessions
      .get("t_claude")
      .tmux.host.calls.options.filter(([, name]: string[]) => name === "@teros_driver")
      .at(-1)
    expect(parseLeaseSnapshot(saved?.[2])?.handedBack).toMatchObject({ note: "your turn" })
    expect(manager.takeHandedBack("t_claude", "agent_atlas")?.note).toBe("your turn")
  })

  it("renaming a sleeping session renames its saved copy", async () => {
    const { manager, store } = await hibernated()
    await manager.rename("t_shell", "prod logs")
    expect(store.docs.get("t_shell")?.title).toBe("prod logs")
    expect(manager.describe("t_shell")?.title).toBe("prod logs")
  })
})

describe("backend restart", () => {
  it("sessions saved to sleep are listed again after a boot (read buffer seeded)", async () => {
    const record: SleepRecord = {
      terminalId: "t_old",
      stackId: "stack_test",
      workspaceId: "work_1",
      appId: "app_fakehost01",
      title: "old",
      kind: "shell",
      createdBy: "u1",
      createdAt: new Date(Date.now() - 86_400_000),
      auth: "",
      cwd: "/workspace",
      cols: 90,
      rows: 20,
      history: "$ echo hi\nhi",
      command: "bash",
      foreground: "",
      agentSession: "",
      sleptAt: new Date(Date.now() - 3600_000),
    }
    record.lease = JSON.stringify({
      driver: { kind: "human", id: "u1", name: "Iria", since: Date.now() - 4000_000 },
      priorAgent: null,
      handedBack: null,
    })
    const other = { ...record, terminalId: "t_other_stack", stackId: "another" }
    const manager = new PtyManager(makePubSub() as any)
    const termHosts = makeTermHosts(makeHost())
    termHosts.hosts.clear()
    manager.useTermHosts(termHosts as any)
    manager.useSleepStore(makeStore([record, other]))
    await manager.adoptTermHosts()
    await manager.whenAdopted()
    const list = manager.list()
    expect(list.map((s) => [s.terminalId, s.lifecycle, s.cols])).toEqual([
      ["t_old", "sleeping", 90],
    ])
    expect(manager.read("t_old").lines).toEqual(["$ echo hi", "hi"])
    // Who had the wheel comes back too.
    expect(manager.describe("t_old")?.driver).toMatchObject({
      kind: "human",
      id: "u1",
      name: "Iria",
    })
  })

  it("a host found paused is adopted (not mistaken for a dead one) and keeps its frozen clock", async () => {
    const host = makeHost()
    await host.createWindow(
      {
        terminalId: "t_a",
        workspaceId: "work_1",
        appId: host.appId,
        title: "",
        kind: "shell",
        createdBy: "u1",
        createdAt: 1,
      },
      { cols: 80, rows: 24 },
    )
    host.windows[0].activityAt = Date.now() - FREEZE - 60_000
    const frozenSince = Date.now() - 30 * 60_000
    host.paused = true
    host.pausedOption = String(frozenSince)
    const manager = new PtyManager(makePubSub() as any, {
      freezeAfterMs: FREEZE,
      hibernateAfterMs: HIBERNATE,
    })
    manager.useTermHosts(makeTermHosts(host) as any)
    await manager.adoptTermHosts()
    expect(manager.describe("t_a")).toMatchObject({ lifecycle: "awake", persistent: true })
    // Idle since before the restart: frozen again, from the original instant.
    sweep(manager, Date.now())
    await flush()
    expect(host.calls.pause).toEqual([frozenSince])
    expect(manager.describe("t_a")?.lifecycle).toBe("frozen")
  })
})

describe("pure pieces", () => {
  it("sessionIsIdle: nothing in or out for FREEZE_AFTER, nobody watching or waiting", () => {
    const base = { lastActivity: 0, viewers: 0, waiting: 0, flooding: false, waking: false }
    expect(sessionIsIdle(base, FREEZE, FREEZE)).toBe(true)
    expect(sessionIsIdle(base, FREEZE - 1, FREEZE)).toBe(false)
    expect(sessionIsIdle({ ...base, viewers: 1 }, FREEZE * 9, FREEZE)).toBe(false)
    expect(sessionIsIdle({ ...base, waiting: 1 }, FREEZE * 9, FREEZE)).toBe(false)
    expect(sessionIsIdle({ ...base, flooding: true }, FREEZE * 9, FREEZE)).toBe(false)
    expect(sessionIsIdle({ ...base, waking: true }, FREEZE * 9, FREEZE)).toBe(false)
  })

  it("boundHistory drops trailing blank rows and keeps the newest 256 KiB", () => {
    expect(boundHistory(["a", "b", "", "  "])).toBe("a\nb")
    const big = Array.from({ length: 4000 }, (_, i) => `${i}`.padEnd(100, "x"))
    const kept = boundHistory(big)
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(256 * 1024)
    expect(kept.endsWith(big[3999])).toBe(true)
  })

  it("resumePlan: Claude Code resumes, codex restarts, a shell is a shell, a dev server is reported", () => {
    expect(resumePlan({ command: "claude", foreground: "claude" })).toMatchObject({
      agent: "claude",
      notRestored: null,
    })
    expect(resumePlan({ command: "codex", foreground: "codex" })).toMatchObject({
      agent: "codex",
      launch: expect.stringContaining("codex"),
    })
    expect(resumePlan({ command: "bash", foreground: "" })).toMatchObject({
      agent: null,
      launch: null,
      notRestored: null,
    })
    const dev = resumePlan({ command: "node", foreground: "npm run dev" })
    expect(dev).toMatchObject({ agent: null, launch: null, notRestored: "npm run dev" })
    expect(dev.message).toContain('"npm run dev" was running and was not restarted')
  })

  it("claudeResumeLine: --resume <id> when its transcript exists, --continue otherwise", () => {
    const line = claudeResumeLine("0b5c2c1e-1111-2222-3333-444455556666")
    expect(line).toContain("/projects/*/0b5c2c1e-1111-2222-3333-444455556666.jsonl")
    expect(line).toContain(
      "then claude --resume 0b5c2c1e-1111-2222-3333-444455556666; else claude --continue; fi",
    )
    expect(line).not.toContain("clear")
    // No id (hooks never reported one) or a hostile one: plain --continue.
    expect(claudeResumeLine("")).toMatch(/; claude --continue$/)
    expect(claudeResumeLine("x; rm -rf /")).toMatch(/; claude --continue$/)
  })

  it("wakeCwdOf: a runner session (bridge + coding agent) always wakes in /workspace — the single boot cwd", () => {
    // Even when it fell asleep deep inside a repo dir that still exists:
    // Claude Code resolves --resume from the launch cwd's project dir, and a
    // repo dir can be untrusted (fb_53dc509e82f7b0c0) — one cwd, one casuística.
    expect(wakeCwdOf(true, "claude", "/workspace/teros", true)).toBe("/workspace")
    expect(wakeCwdOf(true, "codex", "/workspace/teros-deck", true)).toBe("/workspace")
    // And when the recorded cwd is gone, or there never was one.
    expect(wakeCwdOf(true, "claude", "/gone/dir", false)).toBe("/workspace")
    expect(wakeCwdOf(true, "claude", undefined, false)).toBe("/workspace")
  })

  it("wakeCwdOf: a person's session keeps its own cwd while it still exists", () => {
    expect(wakeCwdOf(false, "claude", "/workspace/teros", true)).toBe("/workspace/teros")
    expect(wakeCwdOf(false, null, "/workspace/app", true)).toBe("/workspace/app")
    // Gone (or never recorded): the single boot cwd.
    expect(wakeCwdOf(false, "claude", "/gone", false)).toBe("/workspace")
    expect(wakeCwdOf(false, null, undefined, false)).toBe("/workspace")
  })

  it("wakeCwdOf: a bridge shell (no coding agent to restart) keeps its own cwd", () => {
    // A plain shell an agent opened: no --resume involved, its cwd is safe to
    // restore — the single boot cwd is about coding-agent sessions.
    expect(wakeCwdOf(true, null, "/workspace/app", true)).toBe("/workspace/app")
    expect(wakeCwdOf(true, null, "/gone", false)).toBe("/workspace")
  })

  it("the resume window prints the saved scrollback dimmed, the marker, then a shell (real bash)", () => {
    const file = `/tmp/teros-resume-test-${process.pid}`
    const write = spawnSync("bash", ["-s"], {
      input: resumeHistoryScript(file, "line 'one'\n$(echo pwned)\nTEROS_EOF\nlast", "/tmp"),
      encoding: "utf8",
    })
    expect(write.stdout.trim()).toBe("cwd-ok")
    // `exec bash` at the end becomes the session's shell: here it reads `echo READY` and exits.
    const run = spawnSync("sh", ["-c", resumeWindowCommand(file, "npm run dev")], {
      input: "echo READY\n",
      encoding: "utf8",
    })
    expect(run.stdout).toBe(
      "\x1b[2mline 'one'\n$(echo pwned)\nTEROS_EOF\nlast\x1b[0m\n" +
        "\x1b[2m— resumed after sleep · not restarted: npm run dev —\x1b[0m\nREADY\n",
    )
    expect(spawnSync("test", ["-e", file]).status).not.toBe(0) // cleaned up
  })

  it("the agent-state hook records Claude Code's session id on its pane", () => {
    if (spawnSync("sh", ["-c", "command -v jq"]).status !== 0) return // jq is in the bash image
    const dir = `/tmp/teros-hook-test-${process.pid}`
    spawnSync("mkdir", ["-p", dir])
    // Stand-ins for tmux (records its arguments) and coreutils timeout (absent on macOS).
    spawnSync("sh", [
      "-c",
      `printf '#!/bin/sh\\necho "$@" >> ${dir}/calls\\n' > ${dir}/tmux; printf '#!/bin/sh\\nshift; exec "$@"\\n' > ${dir}/timeout; chmod +x ${dir}/tmux ${dir}/timeout`,
    ])
    const r = spawnSync("bash", ["-c", AGENT_STATE_SCRIPT, "teros-agent-state", "idle"], {
      input: JSON.stringify({ session_id: "abc-123-def", hook_event_name: "SessionStart" }),
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TMUX_PANE: "%7" },
      encoding: "utf8",
    })
    expect(r.status).toBe(0)
    const calls = spawnSync("cat", [`${dir}/calls`], { encoding: "utf8" }).stdout
    spawnSync("rm", ["-rf", dir])
    expect(calls).toContain("set -p -t %7 @agent_session abc-123-def")
  })
})
