/**
 * Discord REST API Client Manager
 *
 * Supports two auth modes:
 * - Bot Token (systemSecret BOT_TOKEN): full guild access, uses "Authorization: Bot <token>"
 * - User OAuth2 token (userSecret ACCESS_TOKEN): limited to user-scoped endpoints, uses "Authorization: Bearer <token>"
 *
 * Bot token takes precedence when available — it unlocks channels, members, and all guild operations.
 * User token is the fallback for user-only operations (list guilds, get own profile).
 */

import { REST, Routes, type RESTPostAPIChannelMessageJSONBody } from "discord.js"

export interface SecretsContext {
  getSystemSecrets: () => Promise<Record<string, string>>
  getUserSecrets: () => Promise<Record<string, string>>
}

export interface DiscordSecrets {
  CLIENT_ID?: string
  CLIENT_SECRET?: string
  BOT_TOKEN?: string
  ACCESS_TOKEN?: string
  REFRESH_TOKEN?: string
}

export interface DiscordSession {
  rest: REST
  /** true if using bot token, false if using user OAuth2 Bearer token */
  isBot: boolean
}

let cachedSession: DiscordSession | null = null
let cachedToken: string | null = null

/**
 * Get an authenticated Discord REST client.
 * Prefers BOT_TOKEN (system secret) for full guild access.
 * Falls back to user OAuth2 ACCESS_TOKEN for user-scoped operations.
 */
export async function getDiscordSession(context: SecretsContext): Promise<DiscordSession> {
  const systemSecrets = (await context.getSystemSecrets()) as DiscordSecrets
  const userSecrets = (await context.getUserSecrets()) as DiscordSecrets

  if (!systemSecrets.CLIENT_ID || !systemSecrets.CLIENT_SECRET) {
    throw new Error(
      "Discord OAuth credentials not configured. Missing CLIENT_ID or CLIENT_SECRET in system secrets.",
    )
  }

  const botToken = userSecrets.BOT_TOKEN
  const userToken = userSecrets.ACCESS_TOKEN

  if (!botToken && !userToken) {
    throw new Error("Discord not connected. Please connect your Discord account.")
  }

  // Prefer bot token — it has full guild access
  const token = botToken || userToken!
  const isBot = !!botToken

  if (cachedSession && cachedToken === token) {
    return cachedSession
  }

  // Bot tokens use "Authorization: Bot <token>", user OAuth2 tokens use "Authorization: Bearer <token>"
  const rest = isBot
    ? new REST({ version: "10" }).setToken(token)
    : new REST({ version: "10", authPrefix: "Bearer" }).setToken(token)

  cachedSession = { rest, isBot }
  cachedToken = token
  return cachedSession
}

/**
 * Quick credential validation: call a simple API endpoint to verify token works.
 */
export async function validateCredentials(context: SecretsContext): Promise<void> {
  const { rest } = await getDiscordSession(context)
  // Try to get current user/bot info
  await rest.get(Routes.user("@me"))
}

/**
 * Helper to handle Discord API errors consistently.
 */
export function handleDiscordError(error: unknown, operation: string): never {
  if (error instanceof Error) {
    const msg = error.message
    if (msg.includes("rate limit") || msg.includes("429")) {
      throw new Error(`Discord rate limit hit during ${operation}. Please retry in a moment.`)
    }
    if (msg.includes("401") || msg.includes("Unauthorized") || msg.includes("invalid token")) {
      throw new Error(`Discord authentication failed during ${operation}. Please reconnect your account.`)
    }
    if (msg.includes("403") || msg.includes("Forbidden")) {
      throw new Error(`Discord permission denied during ${operation}. Check bot permissions or OAuth scopes.`)
    }
    if (msg.includes("404") || msg.includes("Not Found")) {
      throw new Error(`Discord resource not found during ${operation}. Check IDs and names.`)
    }
    if (msg.includes("50001") || msg.includes("Missing Access")) {
      throw new Error(`Discord missing access during ${operation}. The bot/user lacks required permissions.`)
    }
    if (msg.includes("50013") || msg.includes("Missing Permissions")) {
      throw new Error(`Discord missing permissions during ${operation}. The bot needs higher role or additional permissions.`)
    }
    throw new Error(`Discord ${operation} failed: ${msg}`)
  }
  throw new Error(`Unknown error during ${operation}: ${String(error)}`)
}

/**
 * Build a rich embed object for Discord messages.
 */
export function buildEmbed(options: {
  title?: string
  description?: string
  color?: number
  url?: string
  timestamp?: string
  footer?: { text: string; icon_url?: string }
  image?: { url: string }
  thumbnail?: { url: string }
  author?: { name: string; url?: string; icon_url?: string }
  fields?: Array<{ name: string; value: string; inline?: boolean }>
}): Record<string, unknown> {
  const embed: Record<string, unknown> = {}
  if (options.title) embed.title = options.title
  if (options.description) embed.description = options.description
  if (options.color !== undefined) embed.color = options.color
  if (options.url) embed.url = options.url
  if (options.timestamp) embed.timestamp = options.timestamp
  if (options.footer) embed.footer = options.footer
  if (options.image) embed.image = options.image
  if (options.thumbnail) embed.thumbnail = options.thumbnail
  if (options.author) embed.author = options.author
  if (options.fields) embed.fields = options.fields
  return embed
}
