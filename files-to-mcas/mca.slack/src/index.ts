#!/usr/bin/env npx tsx

/**
 * Slack MCA v1.0.0
 *
 * Full Slack workspace integration using McaServer with HTTP transport.
 * Uses Slack Web API via @slack/web-api with OAuth 2.0 authentication.
 * Implements rate limiting with exponential backoff and retry logic.
 *
 * Features:
 * - Health check (credential + connectivity probe)
 * - Channels: list, get, create, archive, join, invite
 * - Messages: send (channels/DMs/threads), list history, thread replies
 * - Reactions: add, remove
 * - Users: list, get by ID/email, presence
 * - Files: upload, list
 * - Search: messages, files
 * - Team info
 */

import { McaServer, type ToolConfig } from "@teros/mca-sdk"
import {
  addReaction,
  archiveChannel,
  createChannel,
  getChannel,
  getTeamInfo,
  getUser,
  getUserPresence,
  healthCheck,
  inviteToChannel,
  joinChannel,
  listChannels,
  listFiles,
  listMessages,
  listUsers,
  removeReaction,
  searchFiles,
  searchMessages,
  sendMessage,
  sendThreadReply,
  uploadFile,
} from "./tools"

const server = new McaServer({
  id: "mca.slack",
  name: "Slack",
  version: "1.0.0",
})

// Helper to register tools — casts needed due to SDK type mismatch
// between server.d.ts and http-server.d.ts ToolContext definitions
const register = (name: string, config: any) => {
  server.tool(name, config)
}

// =============================================================================
// HEALTH CHECK
// =============================================================================

register("-health-check", healthCheck)

// =============================================================================
// CHANNELS
// =============================================================================

register("list-channels", listChannels)
register("get-channel", getChannel)
register("create-channel", createChannel)
register("archive-channel", archiveChannel)
register("join-channel", joinChannel)
register("invite-to-channel", inviteToChannel)

// =============================================================================
// MESSAGES
// =============================================================================

register("send-message", sendMessage)
register("send-thread-reply", sendThreadReply)
register("list-messages", listMessages)

// =============================================================================
// REACTIONS
// =============================================================================

register("add-reaction", addReaction)
register("remove-reaction", removeReaction)

// =============================================================================
// USERS
// =============================================================================

register("list-users", listUsers)
register("get-user", getUser)
register("get-user-presence", getUserPresence)

// =============================================================================
// FILES
// =============================================================================

register("upload-file", uploadFile)
register("list-files", listFiles)

// =============================================================================
// SEARCH
// =============================================================================

register("search-messages", searchMessages)
register("search-files", searchFiles)

// =============================================================================
// TEAM
// =============================================================================

register("get-team-info", getTeamInfo)

// =============================================================================
// START SERVER
// =============================================================================

server.start().catch((error) => {
  console.error("[Slack MCA] Fatal error:", error)
  process.exit(1)
})
