import { describe, expect, it } from "bun:test"
import { evaluateAccess, TERMINAL_SESSION_POLICY } from "@teros/shared"
import {
  agentPrincipal,
  memberPrincipal,
  memberRole,
} from "../../src/services/sharing/principals"
import { sessionThing, terminalPrincipal } from "../../src/services/terminal/terminal-access"

function makeDb(opts: { status?: string; members?: Record<string, any> } = {}) {
  return {
    collection: (name: string) => ({
      findOne: async (filter: any) => {
        if (name === "workspaces") {
          const workspace = { workspaceId: "work_a", ownerId: "u_ada", status: opts.status ?? "active" }
          return filter.status && filter.status !== workspace.status ? null : workspace
        }
        if (name === "workspace_members") return opts.members?.[filter.userId] ?? null
        return null
      },
    }),
  } as any
}

describe("who is asking: a member with a role, or an agent with its workspaces", () => {
  it("[SPACE-AC-6] a person's role is the workspace's own record: owner, admin, write, read, or nothing", async () => {
    const db = makeDb({
      members: {
        u_root: { role: "admin", status: "active" },
        u_quinn: { role: "write" },
        u_rita: { role: "read", status: "active" },
        u_norole: { status: "active" },
        u_invited: { role: "write", status: "pending" },
      },
    })
    expect(await memberRole(db, "u_ada", "work_a")).toBe("owner")
    expect(await memberRole(db, "u_root", "work_a")).toBe("admin")
    expect(await memberRole(db, "u_quinn", "work_a")).toBe("write")
    expect(await memberRole(db, "u_rita", "work_a")).toBe("read")
    expect(await memberRole(db, "u_norole", "work_a")).toBe("read")
    expect(await memberRole(db, "u_invited", "work_a")).toBeNull()
    expect(await memberRole(db, "u_eve", "work_a")).toBeNull()
    expect(await memberPrincipal(db, "u_quinn", "work_a")).toEqual({
      kind: "member",
      userId: "u_quinn",
      workspaceId: "work_a",
      role: "write",
    })
  })

  it("[SPACE-AC-6] an archived workspace gives nobody a role, its owner included", async () => {
    const db = makeDb({ status: "archived", members: { u_quinn: { role: "write" } } })
    expect(await memberRole(db, "u_ada", "work_a")).toBeNull()
    expect(await memberRole(db, "u_quinn", "work_a")).toBeNull()
  })

  it("[SPACE-AC-6] an agent acts in the workspaces it was let into, and in none when it has none", () => {
    expect(agentPrincipal("work_a")).toEqual({ kind: "agent", workspaces: ["work_a"] })
    expect(agentPrincipal(null)).toEqual({ kind: "agent", workspaces: [] })
    expect(agentPrincipal(undefined)).toEqual({ kind: "agent", workspaces: [] })
  })

  it("[SPACE-AC-7] the Terminal's caller becomes a principal: a person by their role, an agent by its app's workspace", async () => {
    const db = makeDb({ members: { u_quinn: { role: "write" } } })
    expect(
      await terminalPrincipal(db, { userId: "u_quinn", bridge: false }, "work_a"),
    ).toMatchObject({ kind: "member", role: "write" })
    expect(
      await terminalPrincipal(db, { userId: "u_ada", bridge: true, workspaceId: "work_a" }, "work_a"),
    ).toEqual({ kind: "agent", workspaces: ["work_a"] })
    expect(
      await terminalPrincipal(db, { userId: "u_ada", bridge: true, workspaceId: "work_b" }, "work_a"),
    ).toEqual({ kind: "agent", workspaces: ["work_b"] })
    const archived = makeDb({ status: "archived" })
    expect(
      await terminalPrincipal(
        archived,
        { userId: "u_ada", bridge: true, workspaceId: "work_a" },
        "work_a",
      ),
    ).toEqual({ kind: "agent", workspaces: [] })
  })

  it("[SPACE-AC-7] a terminal session described as a thing: its space, its person, who may watch, whether agents are in", () => {
    expect(sessionThing({ createdBy: "u_ada" }, "work_a")).toEqual({
      kind: "terminal.session",
      workspaceId: "work_a",
      space: "personal",
      ownerId: "u_ada",
      watchable: false,
      agents: false,
    })
    expect(
      sessionThing({ createdBy: "u_ada", watchable: true, agentControl: true }, "work_a"),
    ).toMatchObject({ space: "personal", ownerId: "u_ada", watchable: true, agents: true })
    expect(
      sessionThing({ createdBy: "u_ada", space: "shared", watchable: true }, "work_a"),
    ).toMatchObject({ space: "shared", ownerId: null, watchable: false, agents: false })
    expect(sessionThing({ createdBy: "agent:app_term_a" }, "work_a")).toMatchObject({
      space: "shared",
      ownerId: null,
      agents: true,
    })
    expect(sessionThing({ createdBy: "agent:app_term_a", agentControl: false }, "work_a").agents).toBe(
      true,
    )
    expect(sessionThing({}, "work_a")).toMatchObject({ space: "shared", ownerId: null, agents: false })
    const mine = sessionThing({ createdBy: "u_ada" }, "work_a")
    const agent = agentPrincipal("work_a")
    expect(evaluateAccess(agent, mine, "see", TERMINAL_SESSION_POLICY)).toEqual({
      allowed: false,
      reason: "agents_off",
    })
  })
})

describe("a session that vanishes while it is being checked", () => {
  it("[SPACE-AC-7] is not found: it is never judged as if it were an open shared terminal", async () => {
    const { checkTerminalAccess } = await import("../../src/services/terminal/terminal-access")
    const db = makeDb({ members: { u_quinn: { role: "write" } } })
    const gone = { has: () => true, ownerOf: () => "work_a", isHost: () => false, describe: () => null }
    expect(
      await checkTerminalAccess(db, gone as any, { userId: "u_quinn", bridge: false }, "t1", "use"),
    ).toBe("TERMINAL_NOT_FOUND")
  })
})
