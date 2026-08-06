#!/usr/bin/env npx tsx

/**
 * Discord MCA v1.0.0
 *
 * Full Discord integration using McaServer with HTTP transport.
 * Uses Discord REST API v10 via discord.js with OAuth 2.0 / Bot Token authentication.
 * Implements rate limiting with built-in REST client retry logic.
 *
 * Features:
 * - Health check (credential + connectivity probe)
 * - Guilds: list, get
 * - Channels: list, get, create, delete
 * - Messages: send, list history, delete
 * - Reactions: add
 * - Members: list, get
 * - Roles: list, create, assign, remove
 * - Webhooks: list, create, send messages
 * - Moderation: kick, ban, timeout, delete messages
 */

import { McaServer } from "@teros/mca-sdk"
import {
  addReaction,
  assignRole,
  banMember,
  createChannel,
  createRole,
  createWebhook,
  deleteChannel,
  deleteMessage,
  getChannel,
  getGuild,
  getMember,
  healthCheck,
  kickMember,
  listChannels,
  listGuilds,
  listMembers,
  listMessages,
  listRoles,
  listWebhooks,
  removeRole,
  sendMessage,
  sendWebhookMessage,
  timeoutMember,
} from "./tools"

const server = new McaServer({
  id: "mca.discord",
  name: "Discord",
  version: "1.0.0",
})

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool("-health-check", healthCheck as any)

// =============================================================================
// GUILDS
// =============================================================================

server.tool("list-guilds", listGuilds as any)
server.tool("get-guild", getGuild as any)

// =============================================================================
// CHANNELS
// =============================================================================

server.tool("list-channels", listChannels as any)
server.tool("get-channel", getChannel as any)
server.tool("create-channel", createChannel as any)
server.tool("delete-channel", deleteChannel as any)

// =============================================================================
// MESSAGES
// =============================================================================

server.tool("send-message", sendMessage as any)
server.tool("list-messages", listMessages as any)
server.tool("delete-message", deleteMessage as any)

// =============================================================================
// REACTIONS
// =============================================================================

server.tool("add-reaction", addReaction as any)

// =============================================================================
// MEMBERS
// =============================================================================

server.tool("list-members", listMembers as any)
server.tool("get-member", getMember as any)

// =============================================================================
// ROLES
// =============================================================================

server.tool("list-roles", listRoles as any)
server.tool("create-role", createRole as any)
server.tool("assign-role", assignRole as any)
server.tool("remove-role", removeRole as any)

// =============================================================================
// WEBHOOKS
// =============================================================================

server.tool("list-webhooks", listWebhooks as any)
server.tool("create-webhook", createWebhook as any)
server.tool("send-webhook-message", sendWebhookMessage as any)

// =============================================================================
// MODERATION
// =============================================================================

server.tool("kick-member", kickMember as any)
server.tool("ban-member", banMember as any)
server.tool("timeout-member", timeoutMember as any)

// =============================================================================
// START SERVER
// =============================================================================

server.start().catch((error) => {
  console.error("[Discord MCA] Fatal error:", error)
  process.exit(1)
})
