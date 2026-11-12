/**
 * Integration test: DeletionService cascades (INF-3).
 *
 * Each entity used to have its own (or two) delete paths leaving different
 * orphans. Checks what each cascade removes, what it keeps on purpose (usage
 * evidence), what it unlinks, that a re-run is harmless, and that unrelated
 * data is untouched.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import { DeletionService } from "../../src/services/deletion-service"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_deletion_${Date.now()}`

let client: MongoClient
let db: Db
let available = false
let service: DeletionService

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
    service = new DeletionService(db)
  } catch {
    console.warn("[deletion service test] Mongo unreachable — skipping")
  }
})

afterAll(async () => {
  if (available) {
    await db.dropDatabase()
    await client.close()
  }
})

const count = (col: string, filter: Record<string, unknown> = {}) =>
  db.collection(col).countDocuments(filter)

async function seed() {
  await db.dropDatabase()
  const ins = (col: string, docs: Record<string, unknown>[]) => db.collection(col).insertMany(docs)
  await ins("agents", [
    { agentId: "a1", ownerId: "u1" },
    { agentId: "a2", ownerId: "u1" },
  ])
  await ins("channels", [
    { channelId: "c1", agentId: "a1", userId: "u1" },
    { channelId: "c2", agentId: "a1", userId: "u1" },
    { channelId: "c3", agentId: "a2", userId: "u1" },
  ])
  await ins("channel_messages", [
    { messageId: "m1", channelId: "c1" },
    { messageId: "m2", channelId: "c1" },
    { messageId: "m3", channelId: "c3" },
  ])
  await ins("sessions", [{ id: "c1" }, { id: "c3" }])
  await ins("session_messages", [{ sessionId: "c1" }, { sessionId: "c3" }])
  await ins("compactions", [{ sessionId: "c1" }])
  await ins("message_feedback", [{ feedbackId: "f1", conversationId: "c1" }])
  await ins("channel_subscriptions", [{ subscriberChannelId: "c3", observedChannelId: "c1" }])
  await ins("automate_starters", [
    { starterId: "s1", action: { type: "channel-event", channelId: "c1", agentId: "a2" } },
    { starterId: "s2", action: { type: "create-task", projectId: "p1", agentId: "a1" } },
    { starterId: "s3", action: { type: "create-task", projectId: "p2", agentId: "a2" } },
  ])
  await ins("api_tokens", [{ token: "t1", userId: "u1", agentId: "a2", channelId: "c1" }])
  await ins("agent_app_access", [
    { agentId: "a1", appId: "app1" },
    { agentId: "a2", appId: "app1" },
  ])
  await ins("agent_skill_access", [{ agentId: "a1", skillId: "sk1" }])
  await ins("projects", [
    { projectId: "p1", boardId: "b1" },
    { projectId: "p2", boardId: "b2" },
  ])
  await ins("boards", [
    { boardId: "b1", projectId: "p1" },
    { boardId: "b2", projectId: "p2" },
  ])
  await ins("tasks", [
    { taskId: "t-1", boardId: "b1", channelId: "c1", assignedAgentId: "a1" },
    { taskId: "t-2", boardId: "b2", assignedAgentId: "a1" },
  ])
  await ins("board_events", [{ boardId: "b1" }, { boardId: "b2" }])
  await ins("board_daily_stats", [{ boardId: "b1", date: "2026-10-17" }])
  await ins("agent_project_relationships", [
    { agentId: "a1", projectId: "p1" },
    { agentId: "a2", projectId: "p2" },
  ])
  // Usage evidence: must survive every cascade
  await ins("llm_usage", [{ channelId: "c1", agentId: "a1" }])
  await ins("agent_usage_sessions", [{ channelId: "c1", agentId: "a1" }])
}

beforeEach(async () => {
  if (available) await seed()
})

describe("DeletionService", () => {
  it("deleteChannel removes the conversation's content and unlinks references", async () => {
    if (!available) return
    const report = await service.deleteChannel("c1", "u1")

    expect(await count("channels", { channelId: "c1" })).toBe(0)
    expect(await count("channel_messages", { channelId: "c1" })).toBe(0)
    expect(await count("sessions", { id: "c1" })).toBe(0)
    expect(await count("session_messages", { sessionId: "c1" })).toBe(0)
    expect(await count("compactions")).toBe(0)
    expect(await count("message_feedback")).toBe(0)
    expect(await count("channel_subscriptions")).toBe(0)
    expect(await count("automate_starters", { starterId: "s1" })).toBe(0)
    // unlinked, not deleted
    expect((await db.collection("tasks").findOne({ taskId: "t-1" }))?.channelId).toBeUndefined()
    expect((await db.collection("api_tokens").findOne({ token: "t1" }))?.channelId).toBeUndefined()
    // evidence and other channels untouched
    expect(await count("llm_usage")).toBe(1)
    expect(await count("channel_messages", { channelId: "c3" })).toBe(1)
    expect(report.channel_messages).toBe(2)
  })

  it("deleteAgent removes its channels, grants, relationships and starters", async () => {
    if (!available) return
    await service.deleteAgent("a1", "u1")

    expect(await count("agents", { agentId: "a1" })).toBe(0)
    expect(await count("channels", { agentId: "a1" })).toBe(0)
    expect(await count("channel_messages", { channelId: "c1" })).toBe(0)
    expect(await count("agent_app_access", { agentId: "a1" })).toBe(0)
    expect(await count("agent_skill_access")).toBe(0)
    expect(await count("agent_project_relationships", { agentId: "a1" })).toBe(0)
    expect(await count("automate_starters", { "action.agentId": "a1" })).toBe(0)
    expect(await db.collection("tasks").countDocuments({ assignedAgentId: "a1" })).toBe(0)
    expect(await count("tasks")).toBe(2) // tasks kept, only unassigned
    // the other agent keeps everything
    expect(await count("agents", { agentId: "a2" })).toBe(1)
    expect(await count("agent_app_access", { agentId: "a2" })).toBe(1)
    expect(await count("channels", { channelId: "c3" })).toBe(1)
    expect(await count("agent_usage_sessions")).toBe(1)
  })

  it("deleteProject removes the board and everything on it", async () => {
    if (!available) return
    await service.deleteProject("p1", "u1")

    expect(await count("projects", { projectId: "p1" })).toBe(0)
    expect(await count("boards", { boardId: "b1" })).toBe(0)
    expect(await count("tasks", { boardId: "b1" })).toBe(0)
    expect(await count("board_events", { boardId: "b1" })).toBe(0)
    expect(await count("board_daily_stats")).toBe(0)
    expect(await count("agent_project_relationships", { projectId: "p1" })).toBe(0)
    expect(await count("automate_starters", { starterId: "s2" })).toBe(0)
    // the other project is intact
    expect(await count("tasks", { boardId: "b2" })).toBe(1)
    expect(await count("board_events", { boardId: "b2" })).toBe(1)
    expect(await count("automate_starters", { starterId: "s3" })).toBe(1)
  })

  it("a re-run after a completed (or interrupted) delete is harmless", async () => {
    if (!available) return
    await service.deleteAgent("a1", "u1")
    const second = await service.deleteAgent("a1", "u1")

    expect(second).toEqual({})
  })
})
