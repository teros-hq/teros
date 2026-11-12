/**
 * Integration test: G2 token authorization (SEC-2).
 *
 * POST /g2 used to accept any `payload.channelId`, so a token could inject
 * messages into another user's conversation and read the agent's reply; and
 * POST /g2/tokens accepted any agentId. Runs the real route + ChannelManager
 * against a throwaway Mongo database over a real HTTP server.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { createServer, request, type Server } from "http"
import { type Db, MongoClient } from "mongodb"
import type { AddressInfo } from "net"
import { hashApiToken } from "../../src/auth/api-tokens"
import { createG2Routes } from "../../src/routes/g2-routes"
import { ChannelManager } from "../../src/services/channel-manager"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_g2_${Date.now()}`

let client: MongoClient
let db: Db
let available = false
let server: Server
let base: string
let wakeUps: Array<{ channelId: string; agentId: string }> = []

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
  } catch {
    console.warn("[g2 token test] Mongo unreachable — skipping")
    return
  }

  const providerService = { resolveProviderForAgent: async () => ({}) } as never
  const channelManager = new ChannelManager(db, providerService)
  const handle = createG2Routes({
    db,
    channelManager,
    providerService,
    // The session for /g2/tokens: "Bearer session:<userId>"
    authService: {
      validateSession: async (token: string) =>
        token.startsWith("session:")
          ? { success: true, user: { userId: token.slice("session:".length) } }
          : { success: false },
    } as never,
    getWakeUpCallback: () => async (channelId: string, agentId: string) => {
      wakeUps.push({ channelId, agentId })
      // Reply immediately so the route's poll returns
      await db.collection("channel_messages").insertOne({
        messageId: `reply_${Date.now()}`,
        channelId,
        role: "assistant",
        content: { type: "text", text: "secret reply" },
        timestamp: new Date(Date.now() + 1000).toISOString(),
      })
    },
  })

  server = createServer((req, res) => {
    void handle(req, res, req.url || "/")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  if (!available) return
  // fetch keeps connections alive; drop them so close() doesn't wait for the idle timeout
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await db.dropDatabase()
  await client.close()
})

beforeEach(async () => {
  if (!available) return
  wakeUps = []
  for (const name of [
    "agents",
    "channels",
    "channel_messages",
    "api_tokens",
    "workspaces",
    "workspace_members",
    "users",
  ]) {
    await db.collection(name).deleteMany({})
  }
  await db.collection("users").insertMany([
    { userId: "user_alice", status: "active" },
    { userId: "user_bob", status: "active" },
  ])
  await db.collection("agents").insertMany([
    { agentId: "agent_alice", ownerId: "user_alice" },
    { agentId: "agent_bob", ownerId: "user_bob" },
  ])
  await db.collection("channels").insertMany([
    { channelId: "ch_alice", userId: "user_alice", agentId: "agent_alice", status: "active" },
    { channelId: "ch_bob", userId: "user_bob", agentId: "agent_bob", status: "active" },
  ])
  await db.collection("api_tokens").insertOne({
    tokenHash: hashApiToken("tok_alice"),
    tokenId: "atok_alice",
    tokenPrefix: "tok_alice",
    agentId: "agent_alice",
    userId: "user_alice",
    createdAt: new Date().toISOString(),
  })
})

/**
 * Minimal HTTP client over node:http. Other suites replace globalThis.fetch
 * with mocks (bun runs every file in one process), so this test can't rely on it.
 */
function post(
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method: "POST", headers }, (res) => {
      res.resume()
      res.on("end", () => resolve({ status: res.statusCode ?? 0 }))
    })
    req.on("error", reject)
    req.end(JSON.stringify(body))
  })
}

function chat(channelId?: string) {
  return post(
    "/g2",
    { Authorization: "Bearer tok_alice", "Content-Type": "application/json" },
    {
      messages: [{ role: "user", content: "hi" }],
      ...(channelId ? { channelId } : {}),
    },
  )
}

describe("POST /g2", () => {
  it("refuses another user's channel and never wakes their agent", async () => {
    if (!available) return
    const res = await chat("ch_bob")

    expect(res.status).toBe(404)
    expect(wakeUps).toHaveLength(0)
    expect(await db.collection("channel_messages").countDocuments({ channelId: "ch_bob" })).toBe(0)
  })

  it("accepts the token user's own channel", async () => {
    if (!available) return
    const res = await chat("ch_alice")

    expect(res.status).toBe(200)
    expect(wakeUps).toEqual([{ channelId: "ch_alice", agentId: "agent_alice" }])
  })

  it("refuses a token whose agent the user can no longer access", async () => {
    if (!available) return
    await db
      .collection("agents")
      .updateOne({ agentId: "agent_alice" }, { $set: { ownerId: "user_bob" } })

    const res = await chat("ch_alice")

    expect(res.status).toBe(403)
    expect(wakeUps).toHaveLength(0)
  })
})

describe("POST /g2 — token owner status (SEC-5)", () => {
  it("refuses a suspended user's token", async () => {
    if (!available) return
    await db
      .collection("users")
      .updateOne({ userId: "user_alice" }, { $set: { status: "suspended" } })

    const res = await chat("ch_alice")

    expect(res.status).toBe(401)
    expect(wakeUps).toHaveLength(0)
  })
})

describe("POST /g2/tokens", () => {
  function createToken(agentId: string) {
    return post(
      "/g2/tokens",
      { Authorization: "Bearer session:user_alice", "Content-Type": "application/json" },
      { agentId },
    )
  }

  it("refuses a token for someone else's agent", async () => {
    if (!available) return
    const res = await createToken("agent_bob")

    expect(res.status).toBe(404)
    expect(await db.collection("api_tokens").countDocuments({ agentId: "agent_bob" })).toBe(0)
  })

  it("creates a token for an own agent", async () => {
    if (!available) return
    const res = await createToken("agent_alice")

    expect(res.status).toBe(201)
  })
})

describe("token management responses (SEC-4)", () => {
  function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const req = request(
        `${base}${path}`,
        {
          method,
          headers: {
            Authorization: "Bearer session:user_alice",
            "Content-Type": "application/json",
          },
        },
        (res) => {
          let data = ""
          res.on("data", (c) => (data += c))
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null }),
          )
        },
      )
      req.on("error", reject)
      req.end(body === undefined ? undefined : JSON.stringify(body))
    })
  }

  it("shows the raw token once, never lists it, and revokes by tokenId", async () => {
    if (!available) return
    const created = await call("POST", "/g2/tokens", { agentId: "agent_alice" })
    expect(created.json.token).toStartWith("tak_")
    expect(created.json.tokenId).toStartWith("atok_")

    const list = await call("GET", "/g2/tokens")
    expect(JSON.stringify(list.json)).not.toContain(created.json.token)
    expect(list.json.map((t: any) => t.tokenId)).toContain(created.json.tokenId)

    expect((await call("DELETE", `/g2/tokens/${created.json.tokenId}`)).status).toBe(200)
    expect(
      await db.collection("api_tokens").countDocuments({ tokenId: created.json.tokenId }),
    ).toBe(0)
  })
})
