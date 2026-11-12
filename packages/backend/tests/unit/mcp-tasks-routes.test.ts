/**
 * Tests — tasks MCP endpoint and Claude Code runner against a real MongoDB
 * (MONGODB_URI, throwaway db) — docs/specs/tasks/20261031_claude-code-runner.md.
 *
 *   - POST /mcp/tasks: auth (CCR-AC-2), initialize/tools/list (CCR-AC-2),
 *     a write attributed to the runner agent (CCR-AC-3), task scope of
 *     writes (CCR-AC-4), protocol errors.
 *   - ClaudeCodeRunner against a scripted WS router: the start (CCR-AC-1,
 *     CCR-AC-5) and the watch (CCR-AC-6).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { Readable } from "node:stream"
import { type Db, MongoClient } from "mongodb"
// The capability registry first: todo.ts on its own hits the registry's circular import.
import "../../src/mca-actions"
import { createApiToken } from "../../src/auth/api-tokens"
import { TODO_NODES_COLLECTION, type TodoNode, todoCapability } from "../../src/mca-actions/todo"
import {
  createMcpTasksRoutes,
  MCP_TASKS_PATH,
  RUNNER_TOOLS,
} from "../../src/routes/mcp-tasks-routes"
import {
  ClaudeCodeRunner,
  type ClaudeCodeRunnerDeps,
  ENV_MCP_CONFIG,
  REMINDER_MESSAGE,
  RUNNER_CWD,
} from "../../src/services/terminal/claude-code-runner"

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017"
const DB_NAME = `teros_ccr_test_${Date.now()}`

const MCA_ID = "mca.teros.todo-list"
const WS = "ws_ccr_1"
const APP = "app_todo_ccr"
const BASH_APP = "app_bash_ccr"
const OWNER = "u_owner"
const RUNNER = "ag_claude_code"
const OTHER_AGENT = "ag_other"

let client: MongoClient
let db: Db
let taskA: string
let taskB: string

const ctx = { mcaId: MCA_ID, appId: APP }
type Any = any
const act = (action: string, body: Record<string, unknown>): Promise<Any> =>
  todoCapability.actions[action](ctx, db, body)
const nodeOf = (nodeId: string) =>
  db.collection<TodoNode>(TODO_NODES_COLLECTION).findOne({ workspaceId: WS, nodeId })

// ── HTTP harness ─────────────────────────────────────────────────────────────

interface Reply {
  status: number
  headers: Record<string, string>
  body: Any
}

async function post(
  handler: ReturnType<typeof createMcpTasksRoutes>,
  token: string | null,
  payload: unknown,
  method = "POST",
  url = MCP_TASKS_PATH,
): Promise<Reply> {
  const req = Readable.from([
    Buffer.from(payload === undefined ? "" : JSON.stringify(payload)),
  ]) as Any
  req.method = method
  req.headers = token ? { authorization: `Bearer ${token}` } : {}
  let status = 0
  let headers: Record<string, string> = {}
  let raw = ""
  const done = new Promise<void>((resolve) => {
    const res = {
      writeHead(code: number, h?: Record<string, string>) {
        status = code
        headers = h ?? {}
      },
      end(chunk?: string) {
        if (chunk) raw += chunk
        resolve()
      },
    } as Any
    void handler(req, res, url).then((handled) => {
      if (!handled) resolve()
    })
  })
  await done
  return { status, headers, body: raw ? JSON.parse(raw) : null }
}

const rpc = (id: number, method: string, params?: unknown) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params ? { params } : {}),
})

// ── Fixtures ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI)
  await client.connect()
  db = client.db(DB_NAME)
  await db.collection("users").insertOne({ userId: OWNER, status: "active", email: "owner@test" })
  await db.collection("workspaces").insertOne({ workspaceId: WS, ownerId: OWNER, name: "CCR" })
  await db.collection("apps").insertMany([
    { appId: APP, mcaId: MCA_ID, ownerType: "workspace", ownerId: WS, status: "active" },
    {
      appId: BASH_APP,
      mcaId: "mca.teros.bash",
      ownerType: "workspace",
      ownerId: WS,
      status: "active",
    },
  ])
  await db.collection("agents").insertMany([
    {
      agentId: RUNNER,
      workspaceId: WS,
      name: "Claude Code",
      fullName: "Claude Code runner",
      status: "active",
      runner: "claude-code",
    },
    {
      agentId: OTHER_AGENT,
      workspaceId: WS,
      name: "Other",
      fullName: "Other agent",
      status: "active",
    },
  ])
  const a = await act("add-node", { text: "Task A", state: "pending" })
  taskA = a.node?.nodeId ?? a.nodeId
  const b = await act("add-node", { text: "Task B", state: "pending" })
  taskB = b.node?.nodeId ?? b.nodeId
  await act("assign-node", { nodeId: taskA, assignee: { kind: "agent", id: RUNNER } })
})

afterAll(async () => {
  await db.dropDatabase()
  await client.close()
})

async function runnerToken(nodeId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { token } = await createApiToken(db, {
    userId: OWNER,
    agentId: RUNNER,
    workspaceId: WS,
    scope: "tasks:run",
    nodeId,
    ...extra,
  })
  return token
}

// ── POST /mcp/tasks ──────────────────────────────────────────────────────────

describe("POST /mcp/tasks", () => {
  const handler = createMcpTasksRoutes({ db: undefined as Any })
  let routes: ReturnType<typeof createMcpTasksRoutes>
  let token: string

  beforeAll(async () => {
    routes = createMcpTasksRoutes({ db })
    token = await runnerToken(taskA)
  })

  it("ignores other urls", async () => {
    expect(await handler(undefined as Any, undefined as Any, "/g2")).toBe(false)
  })

  it("[CCR-AC-2] answers 401 without a token, with a plain token, with an expired one; 405 on GET", async () => {
    expect((await post(routes, null, rpc(1, "ping"))).status).toBe(401)
    const plain = (await createApiToken(db, { userId: OWNER, agentId: RUNNER })).token
    expect((await post(routes, plain, rpc(1, "ping"))).status).toBe(401)
    const expired = await runnerToken(taskA, { ttlMs: -1000 })
    expect((await post(routes, expired, rpc(1, "ping"))).status).toBe(401)
    expect((await post(routes, token, undefined, "GET")).status).toBe(405)
  })

  it("[CCR-AC-2] initialize answers the server and tools/list the fixed tool set with the published schemas", async () => {
    const init = await post(
      routes,
      token,
      rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} }),
    )
    expect(init.status).toBe(200)
    expect(init.body.result.protocolVersion).toBe("2025-06-18")
    expect(init.body.result.serverInfo.name).toBe("teros-tasks")
    expect(init.body.result.capabilities.tools).toBeDefined()

    const list = await post(routes, token, rpc(2, "tools/list"))
    expect(list.status).toBe(200)
    const tools = list.body.result.tools as Array<{
      name: string
      inputSchema: Any
      description: string
    }>
    expect(tools.map((t) => t.name)).toEqual([...RUNNER_TOOLS])
    const progress = tools.find((t) => t.name === "set-progress")!
    expect(progress.inputSchema.required).toContain("nodeId")
    expect(progress.description.length).toBeGreaterThan(20)
  })

  it("notifications answer 202; unknown methods and tools are JSON-RPC errors", async () => {
    const n = await post(routes, token, { jsonrpc: "2.0", method: "notifications/initialized" })
    expect(n.status).toBe(202)
    const m = await post(routes, token, rpc(3, "resources/list"))
    expect(m.body.error.code).toBe(-32601)
    const t = await post(
      routes,
      token,
      rpc(4, "tools/call", { name: "delete-node", arguments: { nodeId: taskA } }),
    )
    expect(t.body.error.code).toBe(-32602)
    const bad = await post(routes, token, rpc(5, "ping"), "POST")
    expect(bad.status).toBe(200)
  })

  it("[CCR-AC-3] a write on the token task runs as the runner agent and is attributed to it in the log", async () => {
    const r = await post(
      routes,
      token,
      rpc(6, "tools/call", { name: "set-progress", arguments: { nodeId: taskA, progress: 40 } }),
    )
    expect(r.status).toBe(200)
    expect(r.body.result.isError).toBe(false)
    expect(r.body.result.structuredContent.node.nodeId).toBe(taskA)
    const node = (await nodeOf(taskA))!
    expect(node.progress).toBe(40)
    const last = node.log[node.log.length - 1]
    expect(last.actor).toEqual({ kind: "agent", id: RUNNER })
  })

  it("[CCR-AC-3] a domain error comes back as a tool error, not a JSON-RPC error", async () => {
    const r = await post(
      routes,
      token,
      rpc(7, "tools/call", { name: "set-progress", arguments: { nodeId: taskA, progress: 250 } }),
    )
    expect(r.status).toBe(200)
    expect(r.body.result.isError).toBe(true)
    expect(r.body.result.structuredContent.code).toBeDefined()
  })

  it("[CCR-AC-4] writes outside the token task answer OUT_OF_SCOPE; subtasks are in scope", async () => {
    const other = await post(
      routes,
      token,
      rpc(8, "tools/call", { name: "set-progress", arguments: { nodeId: taskB, progress: 10 } }),
    )
    expect(other.body.result.isError).toBe(true)
    expect(other.body.result.structuredContent.code).toBe("OUT_OF_SCOPE")
    expect((await nodeOf(taskB))!.progress ?? null).toBeNull()

    const under = await post(
      routes,
      token,
      rpc(9, "tools/call", { name: "add-node", arguments: { parentId: taskA, text: "Sub A1" } }),
    )
    expect(under.body.result.isError).toBe(false)
    const subId =
      under.body.result.structuredContent.node?.nodeId ?? under.body.result.structuredContent.nodeId
    expect(typeof subId).toBe("string")

    const sub = await post(
      routes,
      token,
      rpc(10, "tools/call", { name: "add-log-entry", arguments: { nodeId: subId, text: "note" } }),
    )
    expect(sub.body.result.isError).toBe(false)

    const elsewhere = await post(
      routes,
      token,
      rpc(11, "tools/call", { name: "add-node", arguments: { parentId: taskB, text: "Sub B1" } }),
    )
    expect(elsewhere.body.result.structuredContent.code).toBe("OUT_OF_SCOPE")

    const root = await post(
      routes,
      token,
      rpc(12, "tools/call", { name: "add-node", arguments: { text: "Root" } }),
    )
    expect(root.body.result.structuredContent.code).toBe("OUT_OF_SCOPE")
  })

  it("read tools see the workspace", async () => {
    const r = await post(
      routes,
      token,
      rpc(13, "tools/call", { name: "get-node", arguments: { nodeId: taskB } }),
    )
    expect(r.body.result.isError).toBe(false)
  })
})

// ── ClaudeCodeRunner against a scripted router ───────────────────────────────

interface Call {
  action: string
  params: Record<string, Any>
  ctx: Any
}

/** A WS router whose `terminal.*` answers are scripted; records every call.
 * A turn entry may be a promise: the wait answer then pends until it resolves
 * — the test controls when the turn "ends", so writes that happen mid-turn
 * (the agent blocking through its tools, the operator blocking by hand) land
 * deterministically between wait results. */
function scriptedRouter(turns: Array<Record<string, unknown> | Promise<Record<string, unknown>>>) {
  const calls: Call[] = []
  const router = {
    async dispatch(
      ws: Any,
      ctx: Any,
      requestId: string,
      action: string,
      params: Record<string, Any>,
    ) {
      calls.push({ action, params, ctx })
      let data: unknown = { ok: true }
      if (action === "terminal.status")
        // A session id right away: captureSessionId returns on the first poll
        // instead of burning its whole 30 s window against a scripted router.
        data = { ok: true, agentSession: "ccr-sess-fixture-01" }
      if (action === "terminal.wait" && params.until === "ready")
        data = { met: true, reason: "ready", alive: true, command: "claude" }
      if (action === "terminal.wait" && params.until === "turn") {
        const next = turns.shift()
        data = next
          ? { met: true, alive: true, command: "claude", ...(await next) }
          : { met: false, reason: "ended", alive: false, command: null }
      }
      ws.send(JSON.stringify({ type: "response", requestId, data }))
    },
  }
  return { router, calls }
}

async function until(predicate: () => Promise<boolean>, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error("condition not met in time")
}

describe("ClaudeCodeRunner", () => {
  it("[CCR-AC-1] [CCR-AC-5] startTask opens a seated Claude session with the scoped token in the environment and records it on the task", async () => {
    const { router, calls } = scriptedRouter([])
    const broadcasts: string[] = []
    const deps: ClaudeCodeRunnerDeps = {
      db,
      wsRouter: router,
      mcpUrl: "http://backend:3000/mcp/tasks",
      broadcast: async (_ws, node, action) => {
        broadcasts.push(`${action}:${node.nodeId}`)
      },
    }
    const runner = new ClaudeCodeRunner(deps)
    const t = await act("add-node", { text: "Runner task", state: "pending" })
    const nodeId: string = t.node?.nodeId ?? t.nodeId
    await act("assign-node", { nodeId, assignee: { kind: "agent", id: RUNNER } })
    await act("set-state", { nodeId, state: "working" })
    const node = (await nodeOf(nodeId))!

    const started = await runner.startTask(WS, node, RUNNER, OWNER)
    const record = (started as Any).runner
    expect(record.kind).toBe("claude-code")
    expect(record.terminalId).toMatch(/^term_ccr_/)
    expect(started.log[started.log.length - 1].text).toContain("Claude Code started in terminal")
    expect(started.log[started.log.length - 1].actor).toEqual({ kind: "agent", id: RUNNER })
    expect(started.channelId ?? null).toBeNull()

    const create = calls.find((c) => c.action === "terminal.create")!
    expect(create.params.preset).toBe("claude")
    expect(create.params.appId).toBe(BASH_APP)
    expect(create.params.title).toBe("Runner task")
    expect(create.params.agentId).toBe(RUNNER)
    // The single boot cwd (Pablo, 2-nov): every runner session starts in
    // /workspace — the one trusted dir — never in a repo directory.
    expect(create.params.cwd).toBe(RUNNER_CWD)
    expect(create.ctx.sessionId).toBe(`mca:${BASH_APP}`)
    expect(create.ctx.userId).toBe(OWNER)
    const config = JSON.parse(create.params.launch.env[ENV_MCP_CONFIG])
    const bearer = config.mcpServers["teros-tasks"].headers.Authorization as string
    expect(bearer).toMatch(/^Bearer tak_/)
    expect(create.params.launch.args.join(" ")).not.toContain(bearer.slice(7))
    // The token is scoped to this task (CCR-REQ-3).
    const tokenDoc = await db
      .collection("api_tokens")
      .findOne({ scope: "tasks:run", nodeId, agentId: RUNNER })
    expect(tokenDoc?.workspaceId).toBe(WS)
    expect(tokenDoc?.userId).toBe(OWNER)

    const order = calls.map((c) => `${c.action}${c.params.until ? `:${c.params.until}` : ""}`)
    expect(order.slice(0, 3)).toEqual(["terminal.create", "terminal.wait:ready", "terminal.write"])
    const write = calls.find((c) => c.action === "terminal.write")!
    expect(write.params.data).toContain("mcp__teros-tasks__set-output")
    expect(write.params.sendEnter).toBe(true)
    // The session ended right away in this script: the watch logs it and stops.
    await until(async () =>
      (await nodeOf(nodeId))!.log.some((e) => e.text === "Claude Code session ended"),
    )
    expect(broadcasts.some((b) => b.startsWith("claude-code-runner:"))).toBe(true)
  })

  it("[CCR-REQ-8] a resumed open (--resume) boots in the same single cwd /workspace", async () => {
    // A task whose session is gone but whose sessionId survives: the open
    // recreates the terminal with --resume — and that terminal still boots
    // in RUNNER_CWD, never in a repo dir (Pablo, 2-nov: cwd único).
    const { router, calls } = scriptedRouter([])
    const runner = new ClaudeCodeRunner({
      db,
      wsRouter: router,
      mcpUrl: "http://x/mcp/tasks",
      broadcast: async () => {},
    })
    const t = await act("add-node", { text: "Resumed task", state: "pending" })
    const nodeId: string = t.node?.nodeId ?? t.nodeId
    await act("assign-node", { nodeId, assignee: { kind: "agent", id: RUNNER } })
    await act("set-state", { nodeId, state: "working" })
    // A dead previous session: a terminal nobody answers and a session id to
    // resume (terminalAlive's terminal.status throws → not alive → resume).
    const node = (await nodeOf(nodeId))!
    ;(node as Any).runner = {
      kind: "claude-code",
      terminalId: "term_ccr_deadbeef",
      sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      startedAt: 1,
      lastAliveAt: 1,
      status: "gone",
    }
    const updated = await runner.startTask(WS, node, RUNNER, OWNER)
    const create = calls.find((c) => c.action === "terminal.create")!
    expect(create.params.cwd).toBe(RUNNER_CWD)
    expect(create.params.launch.args.join(" ")).toContain(
      "--resume a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    )
    expect((updated as Any).runner.terminalId).not.toBe("term_ccr_deadbeef")
    expect(updated.log.some((e) => e.text.includes("resumed (--resume"))).toBe(true)
  })

  it("[CCR-AC-6] the watch blocks the task on a question, unblocks on the next turn, reminds once, then stops", async () => {
    const { router, calls } = scriptedRouter([
      { reason: "blocked", question: { question: "Which database?", detail: null } },
      { reason: "done" },
      { reason: "done" },
    ])
    const runner = new ClaudeCodeRunner({
      db,
      wsRouter: router,
      mcpUrl: "http://x/mcp/tasks",
      broadcast: async () => {},
    })
    const t = await act("add-node", { text: "Watched task", state: "pending" })
    const nodeId: string = t.node?.nodeId ?? t.nodeId
    await act("assign-node", { nodeId, assignee: { kind: "agent", id: RUNNER } })
    await act("set-state", { nodeId, state: "working" })
    await runner.startTask(WS, (await nodeOf(nodeId))!, RUNNER, OWNER)

    await until(async () =>
      (await nodeOf(nodeId))!.log.some((e) =>
        e.text.includes("without delivering; the task stays"),
      ),
    )
    const node = (await nodeOf(nodeId))!
    const texts = node.log.map((e) => e.text)
    expect(texts).toContain("Claude Code is waiting: Which database?")
    expect(texts).toContain("Unblocked: Claude Code resumed")
    expect(texts).toContain("Reminder sent: Claude Code ended its turn without delivering")
    expect(node.state).toBe("working")
    expect(node.blockedReason ?? null).toBeNull()
    const reminders = calls.filter(
      (c) => c.action === "terminal.write" && c.params.data === REMINDER_MESSAGE,
    )
    expect(reminders).toHaveLength(1)
    // The blocked transition happened with the question as the reason.
    const blockedEntry = node.log.find((e) => e.text === "Claude Code is waiting: Which database?")
    expect(blockedEntry?.actor).toEqual({ kind: "agent", id: RUNNER })
  })

  it("[CCR-AC-8] a turn ending on a task the agent itself blocked (waiting for the operator) sends no reminder, no unblock, no new turn", async () => {
    // The night of 31-oct: Claude delivers surface 1, blocks through its own
    // tools waiting for the operator's validation, and ends its turn. The
    // watch must leave that block alone — every cycle of "unblock + remind"
    // burned a full LLM turn re-blocking (the reminder loop).
    let releaseTurn1!: () => void
    const turn1 = new Promise<Record<string, unknown>>((resolve) => {
      releaseTurn1 = () => resolve({ reason: "done" })
    })
    const { router, calls } = scriptedRouter([turn1, { reason: "done" }])
    const runner = new ClaudeCodeRunner({
      db,
      wsRouter: router,
      mcpUrl: "http://x/mcp/tasks",
      broadcast: async () => {},
    })
    const t = await act("add-node", { text: "Owner-wait task", state: "pending" })
    const nodeId: string = t.node?.nodeId ?? t.nodeId
    await act("assign-node", { nodeId, assignee: { kind: "agent", id: RUNNER } })
    await act("set-state", { nodeId, state: "working" })
    await runner.startTask(WS, (await nodeOf(nodeId))!, RUNNER, OWNER)

    // The agent blocks through its own MCP tools (as it did at 00:24) while
    // the turn is still open, then the turn ends.
    await act("set-state", {
      nodeId,
      state: "blocked",
      reason: "waiting for the operator's visual validation of surface 1",
    })
    releaseTurn1()

    await until(async () =>
      (await nodeOf(nodeId))!.log.some((e) =>
        e.text.includes("the task stays blocked (waiting for the operator"),
      ),
    )
    const node = (await nodeOf(nodeId))!
    // No unblock, no reminder, watch gone.
    expect(node.state).toBe("blocked")
    expect(node.blockedReason).toBe("waiting for the operator's visual validation of surface 1")
    const texts = node.log.map((e) => e.text)
    expect(texts).not.toContain("Unblocked: Claude Code resumed")
    expect(texts).not.toContain("Reminder sent: Claude Code ended its turn without delivering")
    const reminders = calls.filter(
      (c) => c.action === "terminal.write" && c.params.data === REMINDER_MESSAGE,
    )
    expect(reminders).toHaveLength(0)
    // No new turn either: only the scripted waits, and the watch has ended.
    const turnWaits = calls.filter(
      (c) => c.action === "terminal.wait" && c.params.until === "turn",
    )
    expect(turnWaits.length).toBeLessThanOrEqual(2)
  })

  it("[CCR-AC-8] the operator's manual block replaces the watch's own and is never lifted back to working", async () => {
    // The night of 31-oct, ~00:50: Pablo blocked the task by hand while the
    // watch's own block (a terminal question) stood. No automatic mechanism
    // may move it back to working.
    let releaseTurn1!: () => void
    const turn1 = new Promise<Record<string, unknown>>((resolve) => {
      releaseTurn1 = () => resolve({ reason: "done" })
    })
    const { router, calls } = scriptedRouter([
      { reason: "blocked", question: { question: "Which database?", detail: null } },
      turn1,
      { reason: "done" },
    ])
    const runner = new ClaudeCodeRunner({
      db,
      wsRouter: router,
      mcpUrl: "http://x/mcp/tasks",
      broadcast: async () => {},
    })
    const t = await act("add-node", { text: "Manual-block task", state: "pending" })
    const nodeId: string = t.node?.nodeId ?? t.nodeId
    await act("assign-node", { nodeId, assignee: { kind: "agent", id: RUNNER } })
    await act("set-state", { nodeId, state: "working" })
    await runner.startTask(WS, (await nodeOf(nodeId))!, RUNNER, OWNER)

    // The watch blocks on its terminal question (marker recorded)...
    await until(async () =>
      (await nodeOf(nodeId))!.log.some((e) => e.text === "Claude Code is waiting: Which database?"),
    )
    // ...then the operator replaces the block with his own, by hand.
    await act("set-state", { nodeId, state: "blocked", reason: "weird work in the terminal" })
    releaseTurn1()

    await until(async () =>
      (await nodeOf(nodeId))!.log.some((e) =>
        e.text.includes("the task stays blocked (weird work in the terminal"),
      ),
    )
    const node = (await nodeOf(nodeId))!
    expect(node.state).toBe("blocked")
    expect(node.blockedReason).toBe("weird work in the terminal")
    const texts = node.log.map((e) => e.text)
    expect(texts).not.toContain("Unblocked: Claude Code resumed")
    const reminders = calls.filter(
      (c) => c.action === "terminal.write" && c.params.data === REMINDER_MESSAGE,
    )
    expect(reminders).toHaveLength(0)
  })

  it("startTask fails cleanly when Claude Code never becomes ready (the terminal is destroyed)", async () => {
    const calls: Call[] = []
    const router = {
      async dispatch(
        ws: Any,
        ctx: Any,
        requestId: string,
        action: string,
        params: Record<string, Any>,
      ) {
        calls.push({ action, params, ctx })
        const data =
          action === "terminal.wait"
            ? { met: false, reason: "timeout", alive: true, command: "claude", needsAuth: "claude" }
            : { ok: true }
        ws.send(JSON.stringify({ type: "response", requestId, data }))
      },
    }
    const runner = new ClaudeCodeRunner({
      db,
      wsRouter: router,
      mcpUrl: "http://x/mcp/tasks",
      broadcast: async () => {},
    })
    const t = await act("add-node", { text: "Unready task", state: "pending" })
    const nodeId: string = t.node?.nodeId ?? t.nodeId
    await act("assign-node", { nodeId, assignee: { kind: "agent", id: RUNNER } })
    await act("set-state", { nodeId, state: "working" })
    await expect(runner.startTask(WS, (await nodeOf(nodeId))!, RUNNER, OWNER)).rejects.toThrow(
      /sign-in/,
    )
    expect(calls.some((c) => c.action === "terminal.destroy")).toBe(true)
    expect((await nodeOf(nodeId))!.runner).toBeUndefined()
  })
})
