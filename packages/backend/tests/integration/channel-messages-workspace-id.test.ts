/**
 * Integration test: channel_messages carry workspaceId (sharding prep,
 * docs/architecture/sharding-by-workspace.md).
 *
 * - ChannelManager.saveMessage stamps the channel's workspaceId.
 * - 20261017_010_channel_messages_workspace_id backfills existing messages,
 *   is idempotent and skips channels without workspaceId.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import migration from "../../src/migrations/20261017_010_channel_messages_workspace_id"
import { ChannelManager } from "../../src/services/channel-manager"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_msgws_${Date.now()}`

let client: MongoClient
let db: Db
let available = false
let manager: ChannelManager

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
    manager = new ChannelManager(db, {} as never)
  } catch {
    console.warn("[channel messages workspaceId test] Mongo unreachable — skipping")
  }
})

afterAll(async () => {
  if (available) {
    await db.dropDatabase()
    await client.close()
  }
})

beforeEach(async () => {
  if (!available) return
  await db.dropDatabase()
  await db.collection("channels").insertMany([
    { channelId: "ch_ws", workspaceId: "ws_1", updatedAt: "2026-10-17T09:00:00.000Z" },
    { channelId: "ch_ws2", workspaceId: "ws_2", updatedAt: "2026-10-17T09:00:00.000Z" },
    { channelId: "ch_legacy", updatedAt: "2026-10-17T09:00:00.000Z" },
  ])
})

const msg = (messageId: string, channelId: string) =>
  ({
    messageId,
    channelId,
    role: "user",
    content: { type: "text", text: "hi" },
    timestamp: "2026-10-17T10:00:00.000Z",
  }) as never

const wsOf = async (messageId: string) =>
  (await db.collection("channel_messages").findOne({ messageId }))?.workspaceId

describe("ChannelManager.moveChannelToWorkspace", () => {
  it("moves the messages' workspaceId with the channel", async () => {
    if (!available) return
    await manager.saveMessage(msg("m_mv1", "ch_ws"))
    await manager.saveMessage(msg("m_mv2", "ch_ws"))
    const { channel } = await manager.moveChannelToWorkspace("ch_ws" as never, "ws_2")
    expect(channel?.workspaceId).toBe("ws_2")
    expect(await wsOf("m_mv1")).toBe("ws_2")
    expect(await wsOf("m_mv2")).toBe("ws_2")
  })

  it("re-running the move fixes messages left behind", async () => {
    if (!available) return
    await manager.saveMessage(msg("m_mv3", "ch_ws2"))
    await db.collection("channel_messages").updateOne({ messageId: "m_mv3" }, { $set: { workspaceId: "ws_1" } })
    await manager.moveChannelToWorkspace("ch_ws2" as never, "ws_2")
    expect(await wsOf("m_mv3")).toBe("ws_2")
  })
})

describe("ChannelManager.saveMessage workspaceId", () => {
  it("stores the channel's workspaceId on the message", async () => {
    if (!available) return
    await manager.saveMessage(msg("m1", "ch_ws"))
    expect(await wsOf("m1")).toBe("ws_1")
  })

  it("saves the message without workspaceId when the channel has none", async () => {
    if (!available) return
    await manager.saveMessage(msg("m2", "ch_legacy"))
    const doc = await db.collection("channel_messages").findOne({ messageId: "m2" })
    expect(doc).not.toBeNull()
    expect(doc && "workspaceId" in doc).toBe(false)
  })
})

describe("20261017_010_channel_messages_workspace_id", () => {
  it("backfills from the channel, skips channels without workspaceId, is idempotent", async () => {
    if (!available) return
    const col = db.collection("channel_messages")
    await col.insertMany([
      { messageId: "a1", channelId: "ch_ws" },
      { messageId: "a2", channelId: "ch_ws" },
      { messageId: "b1", channelId: "ch_ws2" },
      // already stamped: left untouched even if it differs from the channel
      { messageId: "b2", channelId: "ch_ws2", workspaceId: "ws_kept" },
      { messageId: "l1", channelId: "ch_legacy" },
      { messageId: "o1", channelId: "ch_missing" },
    ])

    await migration.up(db)

    expect(await wsOf("a1")).toBe("ws_1")
    expect(await wsOf("a2")).toBe("ws_1")
    expect(await wsOf("b1")).toBe("ws_2")
    expect(await wsOf("b2")).toBe("ws_kept")
    expect(await wsOf("l1")).toBeUndefined()
    expect(await wsOf("o1")).toBeUndefined()

    const snapshot = await col.find({}, { projection: { _id: 0 } }).sort({ messageId: 1 }).toArray()
    await migration.up(db)
    expect(await col.find({}, { projection: { _id: 0 } }).sort({ messageId: 1 }).toArray()).toEqual(
      snapshot,
    )
  })
})
