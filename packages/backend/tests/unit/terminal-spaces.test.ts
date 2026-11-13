import { describe, expect, it } from "bun:test"
import type { WsHandlerContext } from "@teros/shared"
import { register } from "../../src/handlers/domains/terminal/index"
import { PtyManager } from "../../src/services/pty-manager"
import { hostPersonOf, spaceOfSession } from "../../src/services/terminal/term-host"

const WORKSPACE = "work_a"
const person = (id: string): WsHandlerContext =>
  ({ userId: id, sessionId: `sess_${id}`, ip: "127.0.0.1" }) as any
const ada = () => person("u_ada")
const quinn = () => person("u_quinn")
const rita = () => person("u_rita")
const eve = () => person("u_eve")
const agent = (): WsHandlerContext =>
  ({ userId: "u_ada", sessionId: "mca:app_term_a", ip: "mca:mca.teros.terminal" }) as any

interface FakeHost {
  person: string | null
  key: string
  container: string
  windows: Array<{ meta: any; opts: any }>
  [k: string]: any
}

function makeHost(owner: string | null): FakeHost {
  const windows: Array<{ meta: any; opts: any }> = []
  return {
    appId: "app_bash_a",
    person: owner,
    key: owner ? `app_bash_a~${owner}` : "app_bash_a",
    container: owner ? `teros-term-fake-${owner}` : "teros-term-fake",
    workspaceId: WORKSPACE,
    windows,
    onAttr: null,
    onPause: null,
    onDisconnect: null,
    async createWindow(meta: any, opts: any) {
      windows.push({ meta, opts })
      return {
        ...meta,
        windowId: `@${windows.length}`,
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
    async runScript() {
      return { code: 0, stdout: "cwd-ok", stderr: "" }
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
}

const db = {
  collection: (name: string) => ({
    findOne: async (filter: any) => {
      if (name === "workspaces")
        return { workspaceId: filter.workspaceId, ownerId: "u_ada", status: "active" }
      if (name !== "workspace_members") return null
      if (filter.userId === "u_quinn")
        return { workspaceId: WORKSPACE, userId: "u_quinn", role: "write", status: "active" }
      if (filter.userId === "u_rita")
        return { workspaceId: WORKSPACE, userId: "u_rita", role: "read", status: "active" }
      return null
    },
  }),
} as any

async function setup(opts: { idleTakeoverMs?: number; providerKey?: string } = {}) {
  const manager = new PtyManager({ broadcastToTopic() {} } as any, {
    lease: { idleTakeoverMs: opts.idleTakeoverMs ?? 60_000 },
  })
  const hosts = new Map<string, FakeHost>()
  const asked: Array<string | null> = []
  const hostOf = (owner: string | null): FakeHost => {
    const key = owner ? `app_bash_a~${owner}` : "app_bash_a"
    const known = hosts.get(key)
    if (known) return known
    const made = makeHost(owner)
    hosts.set(key, made)
    return made
  }
  manager.useTermHosts({
    stackId: "teros_test",
    all: () => [...hosts.values()],
    running: async (_appId: string, owner: string | null = null) =>
      hosts.get(owner ? `app_bash_a~${owner}` : "app_bash_a") ?? null,
    ensure: async (_appId: string, _ws: string, _clone: unknown, personal?: { person: string }) => {
      asked.push(personal?.person ?? null)
      return hostOf(personal?.person ?? null)
    },
    containerName: (_appId: string, owner: string | null = null) =>
      owner ? `teros-term-fake-${owner}` : "teros-term-fake",
    discover: async () => [],
  } as any)
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
      getApp: async (appId: string) => ({
        appId,
        ownerId: WORKSPACE,
        mcaId: "mca.teros.bash",
        scope: appId === "app_bash_mine" ? "personal" : "shared",
        installedBy: "u_ada",
      }),
      isAppVisibleTo: () => true,
    } as any,
    mcaManager: { executeTool: async () => ({}) } as any,
    exec: () => "mca-teros-bash-a",
    db,
    providerService: opts.providerKey
      ? ({
          listUserProviders: async () => [
            { providerId: "p1", providerType: "anthropic", status: "active" },
          ],
          getProviderSecrets: async () => ({ apiKey: opts.providerKey }),
        } as any)
      : null,
    identities: {
      human: async (id: string) => ({ kind: "human", id, name: id }),
      agent: async () => ({ kind: "agent", id: "agent_rex", name: "Rex" }),
    },
  })
  const call = (action: string, ctx: WsHandlerContext, data: Record<string, unknown> = {}) =>
    handlers.get(action)!(ctx, data)
  const open = (ctx: WsHandlerContext, terminalId: string, data: Record<string, unknown> = {}) =>
    call("terminal.create", ctx, { terminalId, appId: "app_bash_a", subscribe: false, ...data })
  const ids = async (ctx: WsHandlerContext) =>
    (await call("terminal.list", ctx)).sessions.map((s: any) => s.terminalId).sort()
  return { manager, call, open, ids, sent, subscriptions, asked, hosts, hostOf }
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (err) => (err as { code?: string }).code ?? String(err),
  )

describe("a terminal lives in one of two spaces", () => {
  it("[SPACE-AC-10] a shared terminal a person opens runs in the workspace's machine, never in a personal one", async () => {
    const { open, asked, hosts, manager } = await setup()
    await open(ada(), "t_shared", { space: "shared" })
    expect(asked).toEqual([null])
    expect([...hosts.keys()]).toEqual(["app_bash_a"])
    expect(hosts.get("app_bash_a")!.windows.map((w) => w.meta.terminalId)).toEqual(["t_shared"])
    expect(manager.describe("t_shared")).toMatchObject({
      space: "shared",
      createdBy: "u_ada",
      openedBy: "person",
      containerId: "teros-term-fake",
    })
  })

  it("[SPACE-AC-11] a person's terminal is personal unless they ask for shared; an agent's is always shared", async () => {
    const { open, asked, manager } = await setup()
    await open(ada(), "t_mine")
    await open(agent(), "t_agent")
    expect(asked).toEqual(["u_ada", null])
    expect(manager.describe("t_mine")).toMatchObject({ space: "personal", openedBy: "person" })
    expect(manager.describe("t_agent")).toMatchObject({ space: "shared", openedBy: "agent" })
    expect(await code(open(agent(), "t_agent_mine", { space: "personal" }))).toBe("INVALID_SPACE")
    expect(await code(open(ada(), "t_bad", { space: "public" }))).toBe("INVALID_SPACE")
    expect(manager.has("t_agent_mine")).toBe(false)
    expect(manager.has("t_bad")).toBe(false)
  })

  it("[SPACE-AC-12] every write member lists, reads, types in, renames and ends a shared terminal", async () => {
    const { open, call, ids, manager } = await setup()
    await open(ada(), "t_shared", { space: "shared" })
    expect(await ids(quinn())).toEqual(["t_shared"])
    for (const [action, data] of [
      ["terminal.read", {}],
      ["terminal.screen", {}],
      ["terminal.status", {}],
      ["terminal.write", { data: "ls", sendEnter: true }],
      ["terminal.input", { data: "x" }],
      ["terminal.resize", { cols: 90, rows: 30 }],
      ["terminal.update", { title: "ours" }],
    ] as Array<[string, Record<string, unknown>]>)
      expect(await code(call(action, quinn(), { terminalId: "t_shared", ...data }))).toBe("ok")
    expect(manager.describe("t_shared")?.title).toBe("ours")
    expect(await code(call("terminal.destroy", quinn(), { terminalId: "t_shared" }))).toBe("ok")
    expect(manager.has("t_shared")).toBe(false)
  })

  it("[SPACE-AC-12] a shared terminal's events go to the workspace, a personal one's only to its person", async () => {
    const { open, sent } = await setup()
    await open(ada(), "t_shared", { space: "shared" })
    await open(ada(), "t_mine")
    const topicsOf = (id: string) => [
      ...new Set(sent.filter((s) => s.event.terminalId === id).map((s) => s.topic)),
    ]
    expect(topicsOf("t_shared")).toEqual(["terminals:work_a"])
    expect(topicsOf("t_mine")).toEqual(["terminals:work_a:u_ada"])
  })

  it("[SPACE-AC-12] a read member and an outsider get nothing of a shared terminal", async () => {
    const { open, call, ids } = await setup()
    await open(ada(), "t_shared", { space: "shared" })
    expect(await ids(rita())).toEqual([])
    expect(await ids(eve())).toEqual([])
    expect(await code(call("terminal.read", rita(), { terminalId: "t_shared" }))).toBe(
      "FORBIDDEN_WORKSPACE_ROLE",
    )
    expect(await code(call("terminal.read", eve(), { terminalId: "t_shared" }))).toBe(
      "FORBIDDEN_TERMINAL",
    )
    expect(await code(open(rita(), "t_rita", { space: "shared" }))).toBe("FORBIDDEN_WORKSPACE_ROLE")
  })

  it("[SPACE-AC-13] the space is saved with the session and decides the machine it wakes in", async () => {
    const { open, hosts, manager, asked } = await setup()
    await open(ada(), "t_shared", { space: "shared" })
    await open(ada(), "t_mine")
    expect(hosts.get("app_bash_a")!.windows[0].meta.space).toBe("shared")
    expect(hosts.get("app_bash_a~u_ada")!.windows[0].meta.space).toBe("personal")
    expect(spaceOfSession({ createdBy: "u_ada", space: "shared" })).toBe("shared")
    expect(hostPersonOf({ createdBy: "u_ada", space: "shared" })).toBeNull()
    expect(hostPersonOf({ createdBy: "u_ada", space: "personal" })).toBe("u_ada")
    expect(hostPersonOf({ createdBy: "u_ada" })).toBe("u_ada")
    expect(hostPersonOf({ createdBy: "agent:app_term_a" })).toBeNull()
    expect(hostPersonOf({ createdBy: "" })).toBeNull()
    hosts.clear()
    asked.length = 0
    const record = {
      terminalId: "t_slept",
      stackId: "teros_test",
      workspaceId: WORKSPACE,
      appId: "app_bash_a",
      title: "Shell 3",
      kind: "shell",
      createdBy: "u_ada",
      space: "shared",
      createdAt: new Date(),
      auth: "",
      cwd: "/workspace",
      cols: 80,
      rows: 24,
      history: "",
      command: "bash",
      foreground: "1",
      agentSession: "",
      lease: "",
      sleptAt: new Date(),
    }
    await (manager as any).waker(record, { userId: "u_quinn" })
    expect(asked).toEqual([null])
    expect(hosts.get("app_bash_a")!.windows.at(-1)!.meta).toMatchObject({
      terminalId: "t_slept",
      space: "shared",
      createdBy: "u_ada",
    })
  })

  it("[SPACE-AC-13] nothing moves a session to the other space", async () => {
    const { open, call, manager } = await setup()
    await open(ada(), "t_shared", { space: "shared" })
    await open(ada(), "t_mine")
    expect(
      await code(call("terminal.watchable", ada(), { terminalId: "t_shared", enabled: true })),
    ).toBe("NOT_WATCHABLE")
    await call("terminal.watchable", ada(), { terminalId: "t_mine", enabled: true })
    await call("terminal.update", ada(), { terminalId: "t_mine", title: "renamed", space: "shared" })
    expect(manager.describe("t_mine")).toMatchObject({ space: "personal", watchable: true })
    expect(manager.describe("t_shared")).toMatchObject({ space: "shared", watchable: false })
    expect(await code(open(ada(), "t_mine", { space: "shared" }))).toBe("ok")
    expect(manager.describe("t_mine")?.space).toBe("personal")
  })
})

describe("agents in a shared terminal", () => {
  it("[SPACE-AC-14] Agent starts off in a shared terminal a person opened: being shared does not let agents in", async () => {
    const { open, call, ids, manager } = await setup()
    await open(ada(), "t_shared", { space: "shared" })
    expect(manager.describe("t_shared")?.agentControl).toBe(false)
    expect(await ids(agent())).toEqual([])
    for (const action of ["terminal.read", "terminal.screen", "terminal.status"])
      expect(await code(call(action, agent(), { terminalId: "t_shared" }))).toBe(
        "FORBIDDEN_TERMINAL",
      )
    expect(
      await code(call("terminal.write", agent(), { terminalId: "t_shared", data: "ls" })),
    ).toBe("FORBIDDEN_TERMINAL")
  })

  it("[SPACE-AC-14] any write member switches Agent on in a shared terminal, not only who opened it", async () => {
    const { open, call, ids } = await setup()
    await open(ada(), "t_shared", { space: "shared" })
    expect(
      await code(call("terminal.agentControl", quinn(), { terminalId: "t_shared", enabled: true })),
    ).toBe("ok")
    expect(await ids(agent())).toEqual(["t_shared"])
    expect(
      await code(call("terminal.write", agent(), { terminalId: "t_shared", data: "ls" })),
    ).toBe("ok")
    expect(
      await code(call("terminal.agentControl", ada(), { terminalId: "t_shared", enabled: false })),
    ).toBe("ok")
    expect(await ids(agent())).toEqual([])
  })

  it("[SPACE-AC-14] while someone is typing in a shared terminal only they switch Agent on", async () => {
    const { open, call } = await setup()
    await open(ada(), "t_shared", { space: "shared" })
    await call("terminal.input", ada(), { terminalId: "t_shared", data: "v" })
    expect(
      await code(call("terminal.agentControl", quinn(), { terminalId: "t_shared", enabled: true })),
    ).toBe("NOT_YOUR_WHEEL")
    expect(
      await code(call("terminal.agentControl", ada(), { terminalId: "t_shared", enabled: true })),
    ).toBe("ok")
  })

  it("[SPACE-AC-14] someone who typed and went quiet does not keep the switch: after the idle time any member switches Agent", async () => {
    const { open, call } = await setup({ idleTakeoverMs: 30 })
    await open(ada(), "t_shared", { space: "shared" })
    await call("terminal.input", ada(), { terminalId: "t_shared", data: "v" })
    expect(
      await code(call("terminal.agentControl", quinn(), { terminalId: "t_shared", enabled: true })),
    ).toBe("NOT_YOUR_WHEEL")
    await new Promise((r) => setTimeout(r, 60))
    expect(
      await code(call("terminal.agentControl", quinn(), { terminalId: "t_shared", enabled: true })),
    ).toBe("ok")
  })

  it("[SPACE-AC-14] an agent never takes a shared terminal a person opened by itself, however idle people are", async () => {
    const { open, call } = await setup({ idleTakeoverMs: 0 })
    await open(ada(), "t_shared", { space: "shared" })
    await call("terminal.input", ada(), { terminalId: "t_shared", data: "v" })
    await new Promise((r) => setTimeout(r, 5))
    expect(
      await code(call("terminal.write", agent(), { terminalId: "t_shared", data: "ls" })),
    ).toBe("FORBIDDEN_TERMINAL")
  })

  it("[SPACE-AC-17] a session with no recorded opener is the workspace's: members reach it, agents only with Agent on", async () => {
    const { manager, hostOf, call, ids } = await setup()
    await manager.createInHost(hostOf(null) as any, "t_old", 80, 24, WORKSPACE, {
      title: "Old",
      kind: "shell",
      createdBy: "",
    })
    expect(manager.describe("t_old")).toMatchObject({ space: "shared", agentControl: false })
    expect(await ids(quinn())).toEqual(["t_old"])
    expect(await ids(agent())).toEqual([])
    expect(await code(call("terminal.read", agent(), { terminalId: "t_old" }))).toBe(
      "FORBIDDEN_TERMINAL",
    )
    await call("terminal.agentControl", quinn(), { terminalId: "t_old", enabled: true })
    expect(await ids(agent())).toEqual(["t_old"])
    expect(await code(call("terminal.read", agent(), { terminalId: "t_old" }))).toBe("ok")
  })

  it("[SPACE-AC-16] a member's shared terminal is given no provider key, even started as Claude Code", async () => {
    const { open, hosts } = await setup({ providerKey: "sk-ant-owner" })
    await open(quinn(), "t_member_claude", { space: "shared", preset: "claude" })
    await open(agent(), "t_agent_claude", { preset: "claude" })
    const windows = hosts.get("app_bash_a")!.windows
    const envOf = (id: string) => windows.find((w) => w.meta.terminalId === id)!.opts.env
    expect(envOf("t_member_claude")).toBeUndefined()
    expect(envOf("t_agent_claude")).toEqual({ ANTHROPIC_API_KEY: "sk-ant-owner" })
    expect(JSON.stringify(windows.find((w) => w.meta.terminalId === "t_member_claude"))).not.toContain(
      "sk-ant-owner",
    )
  })
})

describe("letting the workspace watch a personal terminal", () => {
  it("[SPACE-AC-15] the others see it and cannot act in it", async () => {
    const { open, call, ids, manager } = await setup()
    await open(ada(), "t_mine")
    expect(await ids(quinn())).toEqual([])
    await call("terminal.watchable", ada(), { terminalId: "t_mine", enabled: true })
    expect(manager.describe("t_mine")).toMatchObject({ space: "personal", watchable: true })
    expect(await ids(quinn())).toEqual(["t_mine"])
    for (const action of ["terminal.read", "terminal.screen", "terminal.status", "terminal.subscribe"])
      expect(await code(call(action, quinn(), { terminalId: "t_mine" }))).toBe("ok")
    for (const [action, data] of [
      ["terminal.write", { data: "whoami", sendEnter: true }],
      ["terminal.input", { data: "x" }],
      ["terminal.resize", { cols: 10, rows: 5 }],
      ["terminal.update", { title: "mine now" }],
      ["terminal.destroy", {}],
      ["terminal.takeWheel", {}],
      ["terminal.agentControl", { enabled: true }],
      ["terminal.watchable", { enabled: false }],
    ] as Array<[string, Record<string, unknown>]>)
      expect(await code(call(action, quinn(), { terminalId: "t_mine", ...data }))).toBe(
        "TERMINAL_VIEW_ONLY",
      )
    expect(manager.describe("t_mine")).toMatchObject({
      title: "",
      agentControl: false,
      watchable: true,
    })
    expect(manager.driver("t_mine")?.kind).not.toBe("human")
    expect(await ids(agent())).toEqual([])
    expect(await code(call("terminal.read", agent(), { terminalId: "t_mine" }))).toBe(
      "FORBIDDEN_TERMINAL",
    )
  })

  it("[SPACE-AC-15] a read member does not watch, and only its person switches it", async () => {
    const { open, call, ids } = await setup()
    await open(ada(), "t_mine")
    expect(
      await code(call("terminal.watchable", quinn(), { terminalId: "t_mine", enabled: true })),
    ).toBe("FORBIDDEN_TERMINAL")
    await call("terminal.watchable", ada(), { terminalId: "t_mine", enabled: true })
    expect(await ids(rita())).toEqual([])
    expect(await code(call("terminal.read", rita(), { terminalId: "t_mine" }))).toBe(
      "FORBIDDEN_WORKSPACE_ROLE",
    )
    expect(
      await code(call("terminal.watchable", agent(), { terminalId: "t_mine", enabled: false })),
    ).toBe("FORBIDDEN")
  })

  it("[SPACE-AC-15] when watching stops the others lose the session, its events and its output", async () => {
    const { open, call, ids, sent, subscriptions } = await setup()
    await open(ada(), "t_mine")
    await call("terminal.watchable", ada(), { terminalId: "t_mine", enabled: true })
    await call("terminal.subscribe", quinn(), { terminalId: "t_mine" })
    expect(subscriptions).toContainEqual({ session: "sess_u_quinn", topic: "terminal:t_mine" })
    sent.length = 0
    await call("terminal.watchable", ada(), { terminalId: "t_mine", enabled: false })
    expect(await ids(quinn())).toEqual([])
    expect(subscriptions).not.toContainEqual({ session: "sess_u_quinn", topic: "terminal:t_mine" })
    expect(sent.find((s) => s.topic === "terminals:work_a")?.event).toMatchObject({
      terminalId: "t_mine",
      reason: "unwatchable",
      session: null,
    })
    expect(await code(call("terminal.read", quinn(), { terminalId: "t_mine" }))).toBe(
      "FORBIDDEN_TERMINAL",
    )
  })
})

describe("the shared machine is the workspace's, whatever a caller or a window says", () => {
  it("[SPACE-AC-10] a shared terminal is never built on a personal Bash app, not even the caller's own", async () => {
    const { open, asked, manager } = await setup()
    expect(await code(open(ada(), "t_on_mine", { space: "shared", appId: "app_bash_mine" }))).toBe(
      "PERSONAL_APP",
    )
    expect(asked).toEqual([])
    expect(manager.has("t_on_mine")).toBe(false)
    expect(await code(open(ada(), "t_mine", { appId: "app_bash_mine" }))).toBe("ok")
    expect(asked).toEqual(["u_ada"])
  })

  it("[SPACE-AC-13] after a restart a session's space is the machine it is found in, whatever its window says", async () => {
    const { manager, hostOf, ids, call } = await setup()
    const win = (terminalId: string, createdBy: string, space?: string) => ({
      terminalId,
      workspaceId: WORKSPACE,
      appId: "app_bash_a",
      title: terminalId,
      kind: "shell",
      createdBy,
      createdAt: Date.now(),
      auth: "",
      ...(space ? { space } : {}),
      windowId: `@${terminalId}`,
      paneId: `%${terminalId}`,
      panePid: 1,
      cols: 80,
      rows: 24,
      activityAt: Date.now(),
      command: "bash",
      agentState: "",
      agentSession: "",
      lease: "",
    })
    const sharedHost = hostOf(null) as any
    sharedHost.listWindows = async () => [
      win("t_forged_personal", "u_ada", "personal"),
      win("t_old_person", "u_ada"),
    ]
    const adaHost = hostOf("u_ada") as any
    adaHost.listWindows = async () => [
      win("t_forged_shared", "u_ada", "shared"),
      win("t_forged_owner", "u_quinn", "personal"),
    ]
    for (const host of [sharedHost, adaHost]) {
      host.serverOption = async () => ""
      await (manager as any)._adoptHost(host)
    }
    expect(manager.describe("t_forged_personal")).toMatchObject({ space: "shared" })
    expect(manager.describe("t_old_person")).toMatchObject({ space: "shared" })
    expect(manager.describe("t_forged_shared")).toMatchObject({
      space: "personal",
      createdBy: "u_ada",
    })
    expect(manager.describe("t_forged_owner")).toMatchObject({
      space: "personal",
      createdBy: "u_ada",
    })
    expect(await ids(quinn())).toEqual(["t_forged_personal", "t_old_person"])
    expect(await code(call("terminal.read", quinn(), { terminalId: "t_forged_shared" }))).toBe(
      "FORBIDDEN_TERMINAL",
    )
    expect(await code(call("terminal.read", quinn(), { terminalId: "t_forged_owner" }))).toBe(
      "FORBIDDEN_TERMINAL",
    )
  })

  it("[SPACE-AC-13] a session is refused in a machine of the other space", async () => {
    const { manager, hostOf } = await setup()
    const put = (host: unknown, id: string, meta: Record<string, unknown>) =>
      manager
        .createInHost(host as any, id, 80, 24, WORKSPACE, { title: "", kind: "shell", ...meta } as any)
        .then(
          () => "ok",
          (err) => String(err.message),
        )
    expect(await put(hostOf(null), "t_a", { createdBy: "u_ada", space: "personal" })).toContain(
      "another space",
    )
    expect(await put(hostOf("u_ada"), "t_b", { createdBy: "u_ada", space: "shared" })).toContain(
      "another space",
    )
    expect(await put(hostOf("u_ada"), "t_c", { createdBy: "u_quinn" })).toContain("another space")
    expect(manager.has("t_a") || manager.has("t_b") || manager.has("t_c")).toBe(false)
    expect(await put(hostOf("u_ada"), "t_d", { createdBy: "u_ada" })).toBe("ok")
    expect(await put(hostOf(null), "t_e", { createdBy: "u_ada", space: "shared" })).toBe("ok")
  })

  it("[SPACE-AC-14] taking the keyboard or typing a key does not hand someone the Agent switch while a colleague typed within the idle time", async () => {
    const { open, call } = await setup({ idleTakeoverMs: 60 })
    await open(ada(), "t_shared", { space: "shared" })
    await call("terminal.input", ada(), { terminalId: "t_shared", data: "v" })
    const on = () =>
      code(call("terminal.agentControl", quinn(), { terminalId: "t_shared", enabled: true }))
    expect(await code(call("terminal.takeWheel", quinn(), { terminalId: "t_shared" }))).toBe("ok")
    expect(await on()).toBe("NOT_YOUR_WHEEL")
    await call("terminal.input", quinn(), { terminalId: "t_shared", data: "x" })
    expect(await on()).toBe("NOT_YOUR_WHEEL")
    await new Promise((r) => setTimeout(r, 90))
    expect(await on()).toBe("ok")
  })

  it("[SPACE-AC-14] an agent asking for the session list is subscribed to nothing: no events of terminals it cannot see", async () => {
    const { open, call, subscriptions } = await setup()
    await open(ada(), "t_shared", { space: "shared" })
    const watched = await call("terminal.watch", agent(), { workspaceId: WORKSPACE })
    expect(watched.sessions).toEqual([])
    expect(subscriptions.filter((s) => s.session === "mca:app_term_a")).toEqual([])
    await call("terminal.watch", quinn(), { workspaceId: WORKSPACE })
    expect(subscriptions.filter((s) => s.session === "sess_u_quinn").map((s) => s.topic)).toEqual([
      "terminals:work_a",
      "terminals:work_a:u_quinn",
    ])
  })

  it("[SPACE-AC-12] a close asked for an id that does not exist yet never ends the session later opened under it", async () => {
    const { open, call, manager } = await setup()
    expect(await code(call("terminal.destroy", eve(), { terminalId: "t_future", undoMs: 30 }))).toBe(
      "ok",
    )
    await open(ada(), "t_future")
    await new Promise((r) => setTimeout(r, 80))
    expect(manager.has("t_future")).toBe(true)
    await call("terminal.watchable", ada(), { terminalId: "t_future", enabled: true })
    const closing = await call("terminal.destroy", ada(), { terminalId: "t_future", undoMs: 40 })
    expect(closing.closingInMs).toBe(40)
    await new Promise((r) => setTimeout(r, 90))
    expect(manager.has("t_future")).toBe(false)
  })
})
