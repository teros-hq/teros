/**
 * Tasks MCP endpoint — `POST /mcp/tasks` (CCR-REQ-4).
 *
 * A Streamable-HTTP MCP server that gives a Claude Code session the To Do
 * tools an internal runner has, scoped to ONE task. Claude Code (or any MCP
 * client) connects with the scoped `tak_` token the Claude Code runner minted
 * for the session (CCR-REQ-3); every tool call runs the published To Do
 * action (mca-actions/todo.ts) in the token's workspace, attributed to the
 * token's agent through `callerAgentId` (TODOLG-REQ-1) on behalf of the
 * token's user (`callerUserId`, the billing user).
 *
 * Transport (MCP 2025-06-18, Streamable HTTP, stateless):
 *   POST  JSON-RPC 2.0 request  → 200 application/json with the response
 *   POST  JSON-RPC notification → 202, empty
 *   GET / DELETE                → 405 (no server-initiated stream)
 * Methods: initialize · ping · tools/list · tools/call. No sessions, no
 * resumability: each call stands alone, which is all a tool bridge needs.
 *
 * Tool definitions are the todo-list MCA's own (`tools.json`, the schemas
 * every agent sees), filtered to the runner set below — the endpoint never
 * redefines a tool.
 *
 * @spec CCR-REQ-4
 * @spec CCR-REQ-5
 */
import { readFileSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Db } from "mongodb"
import { type ApiTokenDoc, resolveApiToken } from "../auth/api-tokens"
import { McaActionError } from "../mca-actions/errors"
import { TODO_NODES_COLLECTION, todoCapability } from "../mca-actions/todo"
import { HandlerError } from "../ws-framework/WsRouter"

export const MCP_TASKS_PATH = "/mcp/tasks"
const MCA_ID = "mca.teros.todo-list"
const PROTOCOL_VERSION = "2025-06-18"
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"])
const SERVER_INFO = { name: "teros-tasks", version: "0.1.0" }
const MAX_BODY_BYTES = 1024 * 1024
/** How far up the tree a write may look for the token's task (CCR-REQ-5). */
const MAX_ANCESTOR_DEPTH = 32

/** Tools a runner reads the workspace with (as the To Do actions allow). @spec CCR-REQ-4 */
export const READ_TOOLS = ["get-node", "get-tree", "search-nodes", "get-day"] as const
/** Tools that write — on the token's task or its subtree only (CCR-REQ-5). @spec CCR-REQ-4 */
export const WRITE_TOOLS = [
  "add-node",
  "update-node",
  "add-log-entry",
  "set-progress",
  "set-state",
  "set-input",
  "set-output",
  "toggle-instruction-item",
] as const
export const RUNNER_TOOLS: readonly string[] = [...READ_TOOLS, ...WRITE_TOOLS]
const WRITE_SET = new Set<string>(WRITE_TOOLS)

/** What the session is told on `initialize` (Claude Code shows it as the server's instructions). */
const INSTRUCTIONS =
  "Tools of the Teros task you are working on. Every write is attributed to you in the task log. " +
  "Writes are accepted on your task and its subtasks only; read tools see the workspace. " +
  'Deliver with set-output, then set-state to "review"; when stuck, set-state to "blocked" with your question as the reason.'

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: unknown
}

// ── Tool definitions (the todo-list MCA's tools.json) ───────────────────────

const TOOLS_JSON = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../mcas/mca.teros.todo-list/tools.json",
)
let toolCache: ToolDefinition[] | null = null

/**
 * The runner's tools with the todo-list MCA's published schemas, in the
 * runner-set order. Read once; a missing tools.json (an image without
 * `mcas/`) degrades to name-only definitions so the bridge still works.
 */
export function runnerToolDefinitions(): ToolDefinition[] {
  if (toolCache) return toolCache
  let published: ToolDefinition[] = []
  try {
    const parsed = JSON.parse(readFileSync(TOOLS_JSON, "utf8")) as { tools?: ToolDefinition[] }
    published = Array.isArray(parsed.tools) ? parsed.tools : []
  } catch (err) {
    console.warn(
      `[mcp-tasks] tools.json not readable (${TOOLS_JSON}): ${err instanceof Error ? err.message : err}`,
    )
  }
  const byName = new Map(published.map((t) => [t.name, t]))
  toolCache = RUNNER_TOOLS.map((name) => {
    const t = byName.get(name)
    return {
      name,
      description: t?.description ?? `To Do tool ${name}.`,
      inputSchema: t?.inputSchema ?? { type: "object" },
    }
  })
  return toolCache
}

/** Test seam: forget the cached definitions. */
export function resetRunnerToolDefinitions(): void {
  toolCache = null
}

// ── JSON-RPC ─────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const

function rpcResult(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result }
}
function rpcError(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  }
}

/** The identity a request runs as — resolved once per HTTP call. */
interface RunnerSession {
  token: ApiTokenDoc & { workspaceId: string; nodeId: string }
  /** The workspace's todo-list app: the tenant of every To Do action. */
  appId: string
}

export interface McpTasksRoutesConfig {
  db: Db
}

/**
 * The route: `(req, res, url) => handled?`, like the other Bearer-token APIs
 * (g2-routes.ts). Mounted by http-server.ts for `/mcp/*`.
 * @spec CCR-REQ-4
 */
export function createMcpTasksRoutes(config: McpTasksRoutesConfig) {
  const { db } = config

  return async function mcpTasksRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<boolean> {
    if (url !== MCP_TASKS_PATH) return false
    const method = (req.method ?? "GET").toUpperCase()
    if (method !== "POST") {
      res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" })
      res.end(
        JSON.stringify({ error: "Method not allowed: the tasks MCP endpoint takes POST only" }),
      )
      return true
    }

    const session = await authenticate(db, req)
    if (!session) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="teros-tasks"',
      })
      res.end(
        JSON.stringify({
          error: "A tasks:run API token is required (Authorization: Bearer tak_…)",
        }),
      )
      return true
    }

    let body: unknown
    try {
      body = JSON.parse(await readBody(req))
    } catch (err) {
      json(
        res,
        400,
        rpcError(
          null,
          RPC.PARSE_ERROR,
          `Parse error: ${err instanceof Error ? err.message : String(err)}`,
        ),
      )
      return true
    }

    const messages = Array.isArray(body) ? body : [body]
    if (messages.length === 0) {
      json(res, 400, rpcError(null, RPC.INVALID_REQUEST, "Invalid request: empty batch"))
      return true
    }
    const responses: unknown[] = []
    for (const message of messages) {
      const response = await handleMessage(db, session, message as JsonRpcRequest)
      if (response !== null) responses.push(response)
    }
    if (responses.length === 0) {
      // Notifications only (e.g. notifications/initialized): accepted, nothing to say.
      res.writeHead(202)
      res.end()
      return true
    }
    json(res, 200, Array.isArray(body) ? responses : responses[0])
    return true
  }
}

// ── Auth ─────────────────────────────────────────────────────────────────────

async function authenticate(db: Db, req: IncomingMessage): Promise<RunnerSession | null> {
  const header = req.headers.authorization
  const match = typeof header === "string" ? header.match(/^Bearer\s+(.+)$/i) : null
  if (!match) return null
  const token = await resolveApiToken(db, match[1].trim())
  if (!token || token.scope !== "tasks:run" || !token.workspaceId || !token.nodeId) return null
  const app = await db
    .collection("apps")
    .findOne({ mcaId: MCA_ID, ownerId: token.workspaceId }, { projection: { appId: 1 } })
  if (!app || typeof app.appId !== "string") return null
  return { token: token as RunnerSession["token"], appId: app.appId }
}

// ── Messages ─────────────────────────────────────────────────────────────────

async function handleMessage(
  db: Db,
  session: RunnerSession,
  msg: JsonRpcRequest,
): Promise<unknown | null> {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(
      msg?.id ?? null,
      RPC.INVALID_REQUEST,
      "Invalid request: a JSON-RPC 2.0 message with a method is required",
    )
  }
  const isNotification = msg.id === undefined
  const params = (msg.params ?? {}) as Record<string, unknown>

  try {
    switch (msg.method) {
      case "initialize": {
        const requested =
          typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION
        return rpcResult(msg.id, {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requested)
            ? requested
            : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        })
      }
      case "ping":
        return rpcResult(msg.id, {})
      case "tools/list":
        return rpcResult(msg.id, { tools: runnerToolDefinitions() })
      case "tools/call":
        return rpcResult(msg.id, await callTool(db, session, params))
      default:
        if (isNotification) return null // notifications/initialized, notifications/cancelled…
        return rpcError(msg.id, RPC.METHOD_NOT_FOUND, `Method not found: ${msg.method}`)
    }
  } catch (err) {
    if (err instanceof RpcParamsError) return rpcError(msg.id, RPC.INVALID_PARAMS, err.message)
    console.error("[mcp-tasks] internal error:", err)
    return rpcError(msg.id, RPC.INTERNAL, "Internal error")
  }
}

class RpcParamsError extends Error {}

/**
 * tools/call: the runner tool runs as the To Do action it names. Domain
 * failures (an action error) come back as a tool result with `isError`, as
 * MCP wants — the model reads the code and suggestion and adapts; only
 * protocol problems are JSON-RPC errors.
 * @spec CCR-REQ-4
 * @spec CCR-REQ-5
 */
async function callTool(db: Db, session: RunnerSession, params: Record<string, unknown>) {
  const name = params.name
  if (typeof name !== "string" || !RUNNER_TOOLS.includes(name)) {
    throw new RpcParamsError(`Unknown tool: ${String(name)}. Available: ${RUNNER_TOOLS.join(", ")}`)
  }
  const args = (params.arguments ?? {}) as Record<string, unknown>
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new RpcParamsError("arguments must be an object")
  }

  if (WRITE_SET.has(name)) {
    const target = name === "add-node" ? args.parentId : args.nodeId
    const ok =
      typeof target === "string" &&
      target !== "" &&
      (await inScope(db, session.token.workspaceId, target, session.token.nodeId))
    if (!ok) {
      return toolError(
        "OUT_OF_SCOPE",
        name === "add-node"
          ? `This token may only create subtasks under task ${session.token.nodeId} (or its subtasks).`
          : `This token may only write task ${session.token.nodeId} (or its subtasks).`,
        "Use get-node on your task to find the right nodeId.",
      )
    }
  }

  const handler = todoCapability.actions[name]
  const body = { ...args, callerAgentId: session.token.agentId, callerUserId: session.token.userId }
  try {
    const result = await handler({ mcaId: MCA_ID, appId: session.appId }, db, body)
    return {
      content: [
        {
          type: "text",
          text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
        },
      ],
      ...(result !== null && typeof result === "object" && !Array.isArray(result)
        ? { structuredContent: result }
        : {}),
      isError: false,
    }
  } catch (err) {
    if (err instanceof McaActionError) return toolError(err.code, err.message, err.suggestion)
    if (err instanceof HandlerError) return toolError(err.code, err.message)
    throw err
  }
}

function toolError(code: string, message: string, suggestion?: string) {
  return {
    content: [{ type: "text", text: `${code}: ${message}${suggestion ? ` ${suggestion}` : ""}` }],
    structuredContent: { error: message, code, ...(suggestion ? { suggestion } : {}) },
    isError: true,
  }
}

/**
 * `nodeId` is `rootId` or one of its descendants (walking parents, bounded).
 * Scope: { workspaceId }. A node outside the workspace is out of scope.
 * @spec CCR-REQ-5
 */
export async function inScope(
  db: Db,
  workspaceId: string,
  nodeId: string,
  rootId: string,
): Promise<boolean> {
  let current: string | null = nodeId
  for (let depth = 0; current && depth < MAX_ANCESTOR_DEPTH; depth++) {
    if (current === rootId) return true
    const found: { parentId?: string | null } | null = await db
      .collection<{ workspaceId: string; nodeId: string; parentId?: string | null }>(
        TODO_NODES_COLLECTION,
      )
      .findOne({ workspaceId, nodeId: current }, { projection: { parentId: 1 } })
    if (!found) return false
    const parentId: string | null = typeof found.parentId === "string" ? found.parentId : null
    current = parentId
  }
  return false
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`body larger than ${MAX_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "MCP-Protocol-Version": PROTOCOL_VERSION,
  })
  res.end(JSON.stringify(body))
}
