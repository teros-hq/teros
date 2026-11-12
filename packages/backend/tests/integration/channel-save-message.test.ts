/**
 * Integration test: ChannelManager.saveMessage keeps the channel's ordering
 * fields monotonic (MOD-4).
 *
 * Messages written out of order (G2, terminal, retries) used to $set
 * lastMessageAt to whatever arrived last, moving the conversation back in the
 * list; G2 and the terminal didn't update it at all.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import { ChannelManager } from "../../src/services/channel-manager"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_savemsg_${Date.now()}`

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
    console.warn("[save message test] Mongo unreachable — skipping")
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
  await db.collection("channels").insertOne({
    channelId: "ch_1",
    updatedAt: "2026-10-17T09:00:00.000Z",
    lastMessageAt: "2026-10-17T09:00:00.000Z",
  })
})

const msg = (messageId: string, timestamp: string) =>
  ({
    messageId,
    channelId: "ch_1",
    role: "user",
    content: { type: "text", text: "hi" },
    timestamp,
  }) as never

describe("ChannelManager.saveMessage", () => {
  it("moves lastMessageAt forward and never back", async () => {
    if (!available) return
    await manager.saveMessage(msg("m2", "2026-10-17T10:00:00.000Z"))
    await manager.saveMessage(msg("m1", "2026-10-17T09:30:00.000Z")) // late arrival

    const channel = await db.collection("channels").findOne({ channelId: "ch_1" })
    expect(channel?.lastMessageAt).toBe("2026-10-17T10:00:00.000Z")
    expect(channel?.updatedAt).toBe("2026-10-17T10:00:00.000Z")
    expect(await db.collection("channel_messages").countDocuments({ channelId: "ch_1" })).toBe(2)
  })
})
