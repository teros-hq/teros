import type { Db } from "mongodb"
import { dropIndexIfExists, ensureIndex } from "./helpers.js"
import type { Migration } from "./types.js"

/**
 * Indexes for the conversation hot path (INF-2, docs/audit/20261008_audit-data-layer.md).
 *
 * - channel_messages: the main index was {channelId, createdAt}, but messages
 *   have no createdAt — they sort by `timestamp` — so getMessages /
 *   getRecentMessages / getLastMessage scanned the whole channel and sorted in
 *   memory. Replaced by {channelId, timestamp desc, messageId desc} (messageId
 *   is the pagination tie-break). messageId gets a unique index: it is looked
 *   up on every tool status change and by the pagination cursor.
 * - sessions.id: read on every streamed writeMessage/writePart.
 * - llm_usage {userId, timestamp}: admin usage aggregations filter by both.
 * - projects.projectId: the primary lookup key had no index.
 * - skills / agent_skill_access: no indexes at all in the code.
 *
 * Every index goes through ensureIndex (duplicates and pre-existing indexes
 * can't abort boot). ChannelManager.ensureIndexes stops creating the createdAt
 * index in the same change, so it isn't recreated on the next boot.
 */
const migration: Migration = {
  description:
    "Conversation hot-path indexes: channel_messages (messageId unique, channelId+timestamp), sessions.id, llm_usage userId+timestamp, projects.projectId, skills, agent_skill_access; drop channel_messages channelId+createdAt",

  async up(db: Db): Promise<void> {
    await ensureIndex(
      db,
      "channel_messages",
      { messageId: 1 },
      { name: "messageId_unique", unique: true },
    )
    await ensureIndex(
      db,
      "channel_messages",
      { channelId: 1, timestamp: -1, messageId: -1 },
      { name: "channelId_timestamp_messageId" },
    )
    await dropIndexIfExists(db, "channel_messages", "channelId_1_createdAt_-1")
    console.log("[Migration] channel_messages indexes")

    await ensureIndex(db, "sessions", { id: 1 }, { name: "id_unique", unique: true })
    await ensureIndex(db, "llm_usage", { userId: 1, timestamp: -1 }, { name: "userId_timestamp" })
    await ensureIndex(db, "projects", { projectId: 1 }, { name: "projectId_1", unique: true })
    console.log("[Migration] sessions, llm_usage, projects indexes")

    await ensureIndex(db, "skills", { skillId: 1 }, { name: "skillId_unique", unique: true })
    await ensureIndex(db, "skills", { workspaceId: 1, name: 1 }, { name: "workspaceId_name" })
    await ensureIndex(
      db,
      "agent_skill_access",
      { agentId: 1, skillId: 1 },
      { name: "agentId_skillId_unique", unique: true },
    )
    await ensureIndex(db, "agent_skill_access", { agentId: 1, order: 1 }, { name: "agentId_order" })
    console.log("[Migration] skills, agent_skill_access indexes")
  },

  async down(db: Db): Promise<void> {
    const drops: Array<[string, string]> = [
      ["channel_messages", "messageId_unique"],
      ["channel_messages", "channelId_timestamp_messageId"],
      ["sessions", "id_unique"],
      ["llm_usage", "userId_timestamp"],
      // projects.projectId_1 is not dropped: boot created it before this
      // migration existed (it lives in the index registry, src/db/indexes.ts)
      ["skills", "skillId_unique"],
      ["skills", "workspaceId_name"],
      ["agent_skill_access", "agentId_skillId_unique"],
      ["agent_skill_access", "agentId_order"],
    ]
    for (const [col, name] of drops) {
      await dropIndexIfExists(db, col, name)
    }
    // Restore the previous (useless) index so down() is a faithful inverse
    await db
      .collection("channel_messages")
      .createIndex({ channelId: 1, createdAt: -1 }, { name: "channelId_1_createdAt_-1" })
  },
}

export default migration
