/**
 * Slack Web API Client Manager
 *
 * Manages OAuth2 authentication and exposes the Slack WebClient.
 * Tokens are fetched on-demand from backend via context.getSystemSecrets/getUserSecrets.
 * Implements rate limiting with exponential backoff and retry logic.
 */

import { WebClient, type LogLevel } from "@slack/web-api"

export interface SecretsContext {
  getSystemSecrets: () => Promise<Record<string, string>>
  getUserSecrets: () => Promise<Record<string, string>>
}

export interface SlackSecrets {
  CLIENT_ID?: string
  CLIENT_SECRET?: string
  REDIRECT_URIS?: string
  ACCESS_TOKEN?: string
  REFRESH_TOKEN?: string
  TEAM_ID?: string
  TEAM_NAME?: string
  USER_ID?: string
}

export interface SlackSession {
  client: WebClient
  teamId: string
  teamName: string
  userId: string
}

let cachedSession: SlackSession | null = null
let cachedAccessToken: string | null = null

/**
 * Get an authenticated Slack WebClient.
 * Caches the session by access token; refreshes when token changes.
 */
export async function getSlackSession(context: SecretsContext): Promise<SlackSession> {
  const systemSecrets = (await context.getSystemSecrets()) as SlackSecrets
  const userSecrets = (await context.getUserSecrets()) as SlackSecrets
  const secrets = { ...systemSecrets, ...userSecrets }

  if (!secrets.CLIENT_ID || !secrets.CLIENT_SECRET) {
    throw new Error(
      "Slack OAuth credentials not configured. Missing CLIENT_ID or CLIENT_SECRET in system secrets.",
    )
  }
  if (!secrets.ACCESS_TOKEN) {
    throw new Error("Slack account not connected. Please connect your Slack workspace.")
  }

  if (cachedSession && cachedAccessToken === secrets.ACCESS_TOKEN) {
    return cachedSession
  }

  const client = new WebClient(secrets.ACCESS_TOKEN, {
    retryConfig: {
      retries: 3,
      factor: 2,
      minTimeout: 1000,
      maxTimeout: 30000,
      randomize: true,
    },
    logLevel: "warn" as LogLevel,
  })

  cachedSession = {
    client,
    teamId: secrets.TEAM_ID ?? "",
    teamName: secrets.TEAM_NAME ?? "Unknown",
    userId: secrets.USER_ID ?? "",
  }
  cachedAccessToken = secrets.ACCESS_TOKEN
  return cachedSession
}

/**
 * Quick credential validation: call auth.test to verify token still works.
 */
export async function validateCredentials(context: SecretsContext): Promise<void> {
  const { client } = await getSlackSession(context)
  const result = await client.auth.test()
  if (!result.ok) {
    throw new Error(`Slack auth.test failed: ${result.error}`)
  }
}

/**
 * Helper to handle Slack API errors consistently.
 */
export function handleSlackError(error: unknown, operation: string): never {
  if (error instanceof Error) {
    const msg = error.message
    if (msg.includes("ratelimited") || msg.includes("rate_limited")) {
      throw new Error(`Slack rate limit hit during ${operation}. Please retry in a moment.`)
    }
    if (msg.includes("not_authed") || msg.includes("invalid_auth") || msg.includes("token_revoked")) {
      throw new Error(`Slack authentication failed during ${operation}. Please reconnect your workspace.`)
    }
    if (msg.includes("missing_scope")) {
      throw new Error(`Slack scope insufficient during ${operation}. Reconnect with additional permissions.`)
    }
    if (msg.includes("channel_not_found")) {
      throw new Error(`Channel not found during ${operation}. Check the channel ID.`)
    }
    if (msg.includes("user_not_found")) {
      throw new Error(`User not found during ${operation}. Check the user ID.`)
    }
    if (msg.includes("is_archived")) {
      throw new Error(`Channel is archived during ${operation}. Unarchive it first.`)
    }
    throw new Error(`Slack ${operation} failed: ${msg}`)
  }
  throw new Error(`Unknown error during ${operation}: ${String(error)}`)
}
