/**
 * Integration test: message pagination never skips messages that share a
 * timestamp (MOD-9).
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import { ChannelManager } from "../../src/services/channel-manager"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_msgpage_${Date.now()}`

let client: MongoClient
let db: Db
let available = false

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
  } catch {
    console.warn("[message pagination test] Mongo unreachable — skipping")
  }
})

afterAll(async () => {
  if (available) {
    await db.dropDatabase()
    await client.close()
  }
})

describe("ChannelManager.getMessages pagination", () => {
  it("walks every message exactly once even when timestamps collide", async () => {
    if (!available) return
    const same = "2026-10-17T10:00:00.000Z"
    // 7 messages, 5 of them in the same millisecond (bursts of tool parts)
    const docs = [
      { messageId: "msg_a", timestamp: "2026-10-17T09:59:00.000Z" },
      ...["msg_b", "msg_c", "msg_d", "msg_e", "msg_f"].map((messageId) => ({
        messageId,
        timestamp: same,
      })),
      { messageId: "msg_g", timestamp: "2026-10-17T10:01:00.000Z" },
    ].map((d) => ({
      ...d,
      channelId: "ch_1",
      role: "assistant",
      content: { type: "text", text: d.messageId },
    }))
    await db.collection("channel_messages").insertMany(docs)
    await db
      .collection("channel_messages")
      .insertOne({ messageId: "msg_other", channelId: "ch_2", timestamp: same })
    const manager = new ChannelManager(db, {} as never)

    const seen: string[] = []
    let before: string | undefined
    for (let page = 0; page < 10; page++) {
      const { messages, hasMore } = await manager.getMessages("ch_1" as never, 2, before)
      seen.push(...messages.map((m) => m.messageId))
      if (!hasMore) break
      before = messages[messages.length - 1]?.messageId
    }

    expect(seen.sort()).toEqual(["msg_a", "msg_b", "msg_c", "msg_d", "msg_e", "msg_f", "msg_g"])
  })
})
