/**
 * Integration test: the channel list resolves unread counts and last-message
 * previews in batched aggregations with the same values the old per-channel
 * queries returned, and message search keeps its substring semantics and
 * access rules (MOD-9).
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import { ChannelManager } from "../../src/services/channel-manager"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_chlist_${Date.now()}`

let client: MongoClient
let db: Db
let available = false

const ts = (minute: number) => new Date(Date.UTC(2026, 9, 17, 10, minute)).toISOString()
const long = "x".repeat(150)

let seq = 0
function msg(channelId: string, minute: number, role: string, content: Record<string, unknown>) {
  seq++
  return {
    messageId: `msg_${String(seq).padStart(4, "0")}`,
    channelId,
    workspaceId: channelId === "ch_other_ws" ? "ws_2" : "ws_1",
    role,
    timestamp: ts(minute),
    content,
  }
}

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
  } catch {
    console.warn("[channel list batching test] Mongo unreachable — skipping")
    return
  }

  // Production indexes, so the batched plans run as they would in prod
  const messages = db.collection("channel_messages")
  await messages.createIndex({ channelId: 1, timestamp: -1, messageId: -1 })
  await messages.createIndex({ channelId: 1, "content.type": 1, timestamp: -1 })

  await db.collection("workspaces").insertMany([
    { workspaceId: "ws_1", ownerId: "user_1", status: "active" },
    { workspaceId: "ws_2", ownerId: "user_3", status: "active" },
  ])
  const channel = (channelId: string, minute: number, extra: Record<string, unknown> = {}) => ({
    channelId,
    workspaceId: "ws_1",
    userId: "user_1",
    agentId: "agent_1",
    scope: "personal",
    status: "active",
    metadata: { name: channelId },
    lastMessageAt: ts(minute),
    updatedAt: ts(minute),
    ...extra,
  })
  await db.collection("channels").insertMany([
    // read up to minute 3: only later assistant messages are unread
    channel("ch_read", 50, { lastReadAt: ts(3) }),
    // never read: every assistant message is unread; long text gets truncated
    channel("ch_unread", 49),
    // no text messages: preview falls back to the latest message (image)
    channel("ch_image", 48, { lastReadAt: ts(1) }),
    // only tool executions: fallback preview with empty content
    channel("ch_tools", 47),
    // no messages at all: no preview, 0 unread
    channel("ch_empty", 46),
    // empty lastReadAt behaves like never read
    channel("ch_blank_read", 45, { lastReadAt: "" }),
    // another member's personal conversation and a shared one (search access)
    channel("ch_u2_personal", 44, { userId: "user_2" }),
    channel("ch_u2_shared", 43, { userId: "user_2", scope: "shared" }),
    // a workspace user_1 has no access to
    channel("ch_other_ws", 42, { workspaceId: "ws_2", userId: "user_3" }),
  ])

  await messages.insertMany([
    msg("ch_read", 1, "user", { type: "text", text: "Deploy the Configuration please" }),
    msg("ch_read", 2, "assistant", { type: "text", text: "done" }),
    msg("ch_read", 4, "assistant", { type: "tool_execution", status: "completed" }),
    msg("ch_read", 5, "assistant", { type: "text", text: "second answer" }),
    msg("ch_read", 6, "user", { type: "text", text: "thanks" }),
    msg("ch_read", 7, "assistant", { type: "tool_execution", status: "completed" }),
    msg("ch_unread", 1, "assistant", { type: "text", text: "hi" }),
    msg("ch_unread", 2, "assistant", { type: "text", text: long }),
    msg("ch_unread", 3, "user", { type: "image", url: "x" }),
    msg("ch_image", 1, "assistant", { type: "image", url: "a" }),
    msg("ch_image", 2, "assistant", { type: "image", url: "b" }),
    msg("ch_image", 3, "user", { type: "audio", url: "c" }),
    msg("ch_tools", 1, "assistant", { type: "tool_execution", status: "completed" }),
    msg("ch_tools", 2, "assistant", { type: "tool_execution", status: "running" }),
    msg("ch_blank_read", 1, "assistant", { type: "text", text: "one" }),
    msg("ch_blank_read", 2, "assistant", { type: "file", url: "f" }),
    msg("ch_u2_personal", 1, "user", { type: "text", text: "secret configuration notes" }),
    msg("ch_u2_shared", 1, "user", { type: "text", text: "shared CONFIGURATION doc" }),
    msg("ch_other_ws", 1, "user", { type: "text", text: "configuration elsewhere" }),
  ])
})

afterAll(async () => {
  if (available) {
    await db.dropDatabase()
    await client.close()
  }
})

/** The per-channel queries listUserChannels ran before batching (reference). */
async function oldUnreadCount(channelId: string, lastReadAt?: string): Promise<number> {
  const filter: any = { channelId, role: "assistant" }
  if (lastReadAt) filter.timestamp = { $gt: lastReadAt }
  return db.collection("channel_messages").countDocuments(filter)
}

async function oldLastMessage(channelId: string) {
  const messages = db.collection("channel_messages")
  const textMessage = await messages.findOne(
    { channelId, "content.type": "text" },
    { sort: { timestamp: -1 } },
  )
  if (textMessage) {
    const content = textMessage.content.text || ""
    const truncated = content.length > 100 ? content.substring(0, 100) + "..." : content
    return { content: truncated, timestamp: textMessage.timestamp, role: textMessage.role }
  }
  const message = await messages.findOne({ channelId }, { sort: { timestamp: -1 } })
  if (!message) return undefined
  const labels: Record<string, string> = {
    image: "📷 Imagen",
    audio: "🎵 Audio",
    video: "🎬 Video",
    file: "📎 Archivo",
  }
  return {
    content: labels[message.content?.type] ?? "",
    timestamp: message.timestamp,
    role: message.role,
  }
}

describe("ChannelManager.listUserChannels batched enrichment", () => {
  it("returns the same unreadCount and lastMessage as the per-channel queries", async () => {
    if (!available) return
    const manager = new ChannelManager(db, {} as never)
    const { channels } = await manager.listUserChannels("user_1" as never, undefined, {
      workspaceId: "ws_1",
    })

    expect(channels.map((c) => c.channelId)).toEqual([
      "ch_read",
      "ch_unread",
      "ch_image",
      "ch_tools",
      "ch_empty",
      "ch_blank_read",
      // ch_u2_personal is user_2's personal channel: not listed for user_1 (MUW-REQ-4/5)
      "ch_u2_shared",
    ])

    for (const channel of channels as any[]) {
      expect(channel.unreadCount).toBe(await oldUnreadCount(channel.channelId, channel.lastReadAt))
      expect(channel.lastMessage).toEqual(await oldLastMessage(channel.channelId))
    }

    // Spot-check the expected values so the reference can't drift silently
    const byId = new Map((channels as any[]).map((c) => [c.channelId, c]))
    expect(byId.get("ch_read").unreadCount).toBe(3)
    expect(byId.get("ch_read").lastMessage).toEqual({
      content: "thanks",
      timestamp: ts(6),
      role: "user",
    })
    expect(byId.get("ch_unread").unreadCount).toBe(2)
    expect(byId.get("ch_unread").lastMessage.content).toBe(`${"x".repeat(100)}...`)
    expect(byId.get("ch_image").unreadCount).toBe(1)
    expect(byId.get("ch_image").lastMessage).toEqual({
      content: "🎵 Audio",
      timestamp: ts(3),
      role: "user",
    })
    expect(byId.get("ch_tools").lastMessage).toEqual({
      content: "",
      timestamp: ts(2),
      role: "assistant",
    })
    expect(byId.get("ch_empty").unreadCount).toBe(0)
    expect(byId.get("ch_empty").lastMessage).toBeUndefined()
    expect(byId.get("ch_blank_read").unreadCount).toBe(2)
    expect(byId.get("ch_blank_read").lastMessage.content).toBe("one")
  })

  it("keeps values per page when paginating", async () => {
    if (!available) return
    const manager = new ChannelManager(db, {} as never)
    const first = await manager.listUserChannels("user_1" as never, undefined, {
      workspaceId: "ws_1",
      limit: 3,
    })
    const second = await manager.listUserChannels("user_1" as never, undefined, {
      workspaceId: "ws_1",
      limit: 3,
      cursor: first.nextCursor!,
    })
    expect(second.channels.map((c) => c.channelId)).toEqual(["ch_tools", "ch_empty", "ch_blank_read"])
    for (const channel of [...first.channels, ...second.channels] as any[]) {
      expect(channel.unreadCount).toBe(await oldUnreadCount(channel.channelId, channel.lastReadAt))
      expect(channel.lastMessage).toEqual(await oldLastMessage(channel.channelId))
    }
  })
})

describe("ChannelManager.searchMessages", () => {
  it("matches case-insensitive substrings inside words, only in accessible channels", async () => {
    if (!available) return
    const manager = new ChannelManager(db, {} as never)
    // "onfig" is a fragment of a word: search-as-you-type depends on substring
    // matching, which a $text index would not provide.
    const { results, totalMatches } = await manager.searchMessages("user_1" as never, "onfig")

    expect(totalMatches).toBe(2)
    expect(results.map((r) => r.channelId).sort()).toEqual(["ch_read", "ch_u2_shared"])
    const read = results.find((r) => r.channelId === "ch_read")!
    expect(read.matches[0]!.snippet).toBe("Deploy the Configuration please")
  })

  it("leaves personal history out when includePersonal is false", async () => {
    if (!available) return
    const manager = new ChannelManager(db, {} as never)
    const { results } = await manager.searchMessages("user_1" as never, "configuration", 50, {
      includePersonal: false,
    })
    expect(results.map((r) => r.channelId)).toEqual(["ch_u2_shared"])
  })

  it("a pending invitation does not open a workspace's shared channels to search", async () => {
    if (!available) return
    const manager = new ChannelManager(db, {} as never)
    await db.collection("channels").insertOne({
      channelId: "ch_ws2_shared",
      workspaceId: "ws_2",
      userId: "user_3",
      agentId: "agent_1",
      scope: "shared",
      status: "active",
      metadata: { name: "ch_ws2_shared" },
    })
    await db.collection("channel_messages").insertOne(msg("ch_ws2_shared", 1, "user", { type: "text", text: "roadmap draft" }))
    const members = db.collection("workspace_members")
    try {
      await members.insertOne({ workspaceId: "ws_2", userId: "user_1", role: "write", status: "pending" })
      expect((await manager.searchMessages("user_1" as never, "roadmap")).totalMatches).toBe(0)

      await members.updateOne({ workspaceId: "ws_2", userId: "user_1" }, { $set: { status: "active" } })
      expect((await manager.searchMessages("user_1" as never, "roadmap")).totalMatches).toBe(1)
    } finally {
      await members.deleteMany({ workspaceId: "ws_2" })
      await db.collection("channels").deleteOne({ channelId: "ch_ws2_shared" })
      await db.collection("channel_messages").deleteMany({ channelId: "ch_ws2_shared" })
    }
  })
})
