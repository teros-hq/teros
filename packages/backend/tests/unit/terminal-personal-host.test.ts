import { describe, expect, it } from "bun:test"
import type { WsHandlerContext } from "@teros/shared"
import { register } from "../../src/handlers/domains/terminal/index"
import { PtyManager } from "../../src/services/pty-manager"
import { TermHostManager } from "../../src/services/terminal/term-host"

const BASH_CONTAINER = {
  Config: {
    Image: "teros/mca-runtime-bash:latest",
    Env: ["MCA_CALLBACK_TOKEN=secret", "HOME=/app-data/home", "PATH=/usr/bin"],
    WorkingDir: "/app",
  },
  HostConfig: {},
  Mounts: [
    { Type: "bind", Source: "/srv/ws/.apps/bash", Destination: "/app-data", RW: true },
    { Type: "bind", Source: "/srv/ws/files", Destination: "/workspace", RW: true },
  ],
  NetworkSettings: { Networks: {} },
}

function makeManager(existingVolumes: string[] = []) {
  const calls: string[][] = []
  const volumes = new Set(existingVolumes)
  const manager = new TermHostManager({
    stackId: "teros_test",
    docker: async (args: string[]) => {
      calls.push(args)
      if (args[0] === "inspect" && args[1] === "--format")
        return { code: 1, stdout: "", stderr: "" }
      if (args[0] === "inspect")
        return { code: 0, stdout: JSON.stringify([BASH_CONTAINER]), stderr: "" }
      if (args[0] === "volume" && args[1] === "inspect")
        return { code: volumes.has(args[2]) ? 0 : 1, stdout: "", stderr: "" }
      if (args[0] === "volume" && args[1] === "create") volumes.add(args[args.length - 1])
      return { code: 0, stdout: "", stderr: "" }
    },
    execStream: () => {
      throw new Error("no tmux in this test")
    },
  } as any)
  const start = (person?: string, seedSharedHome = false) =>
    manager
      .ensure(
        "app_bash_a",
        "work_a",
        async () => "mca-teros-bash-a",
        person ? { person, seedSharedHome } : undefined,
      )
      .catch(() => undefined)
  const runOf = () => calls.filter((c) => c[0] === "run" && c.includes("-d")).at(-1) ?? []
  const mounts = (run: string[]) => run.filter((_, i) => run[i - 1] === "-v")
  return { manager, calls, start, runOf, mounts }
}

describe("a person's sessions run in their own host with a private home", () => {
  it("[TW-AC-18] the personal host mounts that person's home volume at the image's home directory", async () => {
    const { manager, calls, start, runOf, mounts } = makeManager()
    await start("u_ada")
    const volume = manager.homeVolumeName("work_a", "u_ada")
    expect(volume).toMatch(/^teros-home-[0-9a-f]{6}-[0-9a-f]{12}-[0-9a-f]{12}$/)
    expect(calls).toContainEqual([
      "volume",
      "create",
      "--label",
      "teros.home.stack=teros_test",
      "--label",
      "teros.home.workspace=work_a",
      "--label",
      "teros.home.person=u_ada",
      volume,
    ])
    const run = runOf()
    expect(run).toContain(manager.containerName("app_bash_a", "u_ada"))
    expect(run).toContain("teros.term.person=u_ada")
    expect(mounts(run)).toContain(`${volume}:/app-data/home:rw`)
  })

  it("[TW-AC-18] the home is a volume that already exists on the next start: it is reused, not made again", async () => {
    const first = makeManager()
    await first.start("u_ada")
    const volume = first.manager.homeVolumeName("work_a", "u_ada")
    const next = makeManager([volume])
    await next.start("u_ada", true)
    expect(next.calls.filter((c) => c[0] === "volume" && c[1] === "create")).toEqual([])
    expect(next.calls.filter((c) => c[0] === "run" && c.includes("--rm"))).toEqual([])
    expect(next.mounts(next.runOf())).toContain(`${volume}:/app-data/home:rw`)
  })

  it("[TW-AC-19] the agents' host has no private home, and each person has their own container and volume", async () => {
    const agents = makeManager()
    await agents.start()
    expect(agents.mounts(agents.runOf())).toEqual([
      "/srv/ws/.apps/bash:/app-data:rw",
      "/srv/ws/files:/workspace:rw",
    ])
    expect(agents.calls.filter((c) => c[0] === "volume")).toEqual([])
    const { manager } = agents
    const names = [
      manager.containerName("app_bash_a"),
      manager.containerName("app_bash_a", "u_ada"),
      manager.containerName("app_bash_a", "u_quinn"),
    ]
    expect(new Set(names).size).toBe(3)
    expect(manager.homeVolumeName("work_a", "u_ada")).not.toBe(
      manager.homeVolumeName("work_a", "u_quinn"),
    )
    expect(manager.homeVolumeName("work_a", "u_ada")).not.toBe(
      manager.homeVolumeName("work_b", "u_ada"),
    )
  })

  it("[TW-AC-19] the private home is not a path of the workspace volume", async () => {
    const { manager, start, runOf, mounts } = makeManager()
    await start("u_ada")
    const home = mounts(runOf()).find((m) => m.endsWith(":/app-data/home:rw")) ?? ""
    expect(home.startsWith(manager.homeVolumeName("work_a", "u_ada"))).toBe(true)
    expect(home.startsWith("/")).toBe(false)
  })

  it("[TW-AC-21] the owner's first private home starts as a copy of the workspace's old shared home; nobody else's does", async () => {
    const owner = makeManager()
    await owner.start("u_ada", true)
    const volume = owner.manager.homeVolumeName("work_a", "u_ada")
    const copies = owner.calls.filter((c) => c[0] === "run" && c.includes("--rm"))
    expect(copies).toHaveLength(1)
    expect(copies[0]).toContain("/srv/ws/.apps/bash/home:/from:ro")
    expect(copies[0]).toContain(`${volume}:/to`)
    const member = makeManager()
    await member.start("u_quinn", false)
    expect(member.calls.filter((c) => c[0] === "run" && c.includes("--rm"))).toEqual([])
  })
})

describe("which host a new session goes to", () => {
  async function setup() {
    const manager = new PtyManager({ broadcastToTopic() {} } as any)
    const asked: Array<{ appId: string; personal: unknown }> = []
    manager.useTermHosts({
      stackId: "teros_test",
      all: () => [],
      running: async () => null,
      ensure: async (appId: string, _ws: string, _clone: unknown, personal: unknown) => {
        asked.push({ appId, personal })
        throw new Error("stop here")
      },
      discover: async () => [],
    } as any)
    const handlers = new Map<string, (ctx: WsHandlerContext, data: unknown) => Promise<any>>()
    register({ register: (a: string, h: any) => handlers.set(a, h) } as any, {
      pubSubService: {
        subscribeSession() {},
        unsubscribeSession() {},
        broadcastToTopic() {},
      } as any,
      ptyManager: manager,
      mcaService: {
        getApp: async (appId: string) => ({
          appId,
          ownerId: "work_a",
          mcaId: "mca.teros.bash",
          scope: appId === "app_bash_personal" ? "personal" : "shared",
          installedBy: "u_ada",
        }),
        isAppVisibleTo: (app: any, userId: string) =>
          app.scope === "shared" || app.installedBy === userId,
      } as any,
      mcaManager: { executeTool: async () => ({}) } as any,
      exec: () => "",
      db: {
        collection: (name: string) => ({
          findOne: async (filter: any) => {
            if (name === "workspaces")
              return { workspaceId: filter.workspaceId, ownerId: "u_ada", status: "active" }
            if (name === "workspace_members" && filter.userId === "u_quinn")
              return { workspaceId: "work_a", userId: "u_quinn", role: "write", status: "active" }
            return null
          },
        }),
      } as any,
      identities: {
        human: async (id: string) => ({ kind: "human", id, name: id }),
        agent: async () => ({ kind: "agent", id: "agent_rex", name: "Rex" }),
      },
    })
    const create = (ctx: Partial<WsHandlerContext>, terminalId: string, appId = "app_bash_a") =>
      handlers.get("terminal.create")!({ ip: "127.0.0.1", ...ctx } as any, {
        terminalId,
        appId,
      }).catch((err: { code?: string }) => err.code)
    return { create, asked }
  }

  it("[TW-AC-14] a member cannot open a terminal on another member's personal Bash app", async () => {
    const { create, asked } = await setup()
    expect(
      await create({ userId: "u_quinn", sessionId: "sess_quinn" }, "t4", "app_bash_personal"),
    ).toBe("FORBIDDEN_APP")
    expect(asked).toEqual([])
    await create({ userId: "u_ada", sessionId: "sess_ada" }, "t5", "app_bash_personal")
    expect(asked).toEqual([
      { appId: "app_bash_personal", personal: { person: "u_ada", seedSharedHome: true } },
    ])
  })

  it("[TW-AC-18] a person's session goes to their personal host; only the owner's home is seeded", async () => {
    const { create, asked } = await setup()
    await create({ userId: "u_ada", sessionId: "sess_ada" }, "t1")
    await create({ userId: "u_quinn", sessionId: "sess_quinn" }, "t2")
    expect(asked).toEqual([
      { appId: "app_bash_a", personal: { person: "u_ada", seedSharedHome: true } },
      { appId: "app_bash_a", personal: { person: "u_quinn", seedSharedHome: false } },
    ])
  })

  it("[TW-AC-19] an agent's session goes to the agents' host, never to a person's", async () => {
    const { create, asked } = await setup()
    await create({ userId: "u_ada", sessionId: "mca:app_term_a" }, "t3")
    expect(asked).toEqual([{ appId: "app_bash_a", personal: undefined }])
  })
})
