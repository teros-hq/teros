/**
 * Slack Web API Client Manager
 *
 * Manages OAuth2 authentication and exposes the Slack `WebClient`. Tokens
 * are fetched on-demand from the backend via `context.getSystemSecrets` /
 * `context.getUserSecrets` (lazy — never preloaded at module load).
 *
 * Retry / error classification lives in `tools/utils.ts:wrapSlackCall` and
 * `tools/_slack-error.ts:classifySlackApiError`. We DO NOT pass `retryConfig`
 * to the SDK — that retried mutations indiscriminately and duplicated
 * messages/reactions. Read tools opt in via `wrapSlackCall`; mutations use
 * `wrapSlackMutation` (no retry).
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
  /** User-scoped access token (`authed_user.access_token`, "xoxp-..."). Used by 95% of tools. */
  ACCESS_TOKEN?: string
  /** Bot-scoped access token (`access_token`, "xoxb-..."). Used by tools requiring bot-only scopes
   *  (channels:manage, chat:write.customize, conversations.connect:*, remote_files:*). */
  BOT_ACCESS_TOKEN?: string
  REFRESH_TOKEN?: string
  TEAM_ID?: string
  TEAM_NAME?: string
  USER_ID?: string
}

export interface SlackSession {
  /** User-token client. Default for read-on-behalf-of-user + most mutations. */
  client: WebClient
  /** Bot-token client. Falls back to `client` when no bot token is provisioned —
   *  some workspace flows hand back only a user token. Tools requiring bot-only
   *  scopes will fail at the API boundary with `missing_scope` if the workspace
   *  install lacks them. */
  botClient: WebClient
  /** Whether a distinct bot token was installed (false → botClient === client). */
  hasBotToken: boolean
  teamId: string
  teamName: string
  userId: string
}

let cachedSession: SlackSession | null = null
let cachedAccessToken: string | null = null
let cachedBotToken: string | null = null

/**
 * Get an authenticated Slack session with dual clients (user + bot).
 *
 * Slack OAuth v2 hands back two tokens on install:
 *  - `access_token` → bot identity scopes (channels:manage, conversations.connect:*, remote_files:*, …).
 *  - `authed_user.access_token` → user identity scopes (channels:read, im:write, …).
 *
 * Tools default to `session.client` (user). The ~11 tools needing bot-only
 * scopes (create-channel, archive-channel, slack-connect-*, remote-files-*)
 * use `session.botClient`.
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
    throw new Error("Slack workspace not connected. Please connect via OAuth from app settings.")
  }

  const userToken = secrets.ACCESS_TOKEN
  const botToken = secrets.BOT_ACCESS_TOKEN ?? null

  if (
    cachedSession &&
    cachedAccessToken === userToken &&
    cachedBotToken === botToken
  ) {
    return cachedSession
  }

  const client = new WebClient(userToken, {
    logLevel: "warn" as LogLevel,
  })

  const botClient = botToken
    ? new WebClient(botToken, { logLevel: "warn" as LogLevel })
    : client

  cachedSession = {
    client,
    botClient,
    hasBotToken: Boolean(botToken),
    teamId: secrets.TEAM_ID ?? "",
    teamName: secrets.TEAM_NAME ?? "Unknown",
    userId: secrets.USER_ID ?? "",
  }
  cachedAccessToken = userToken
  cachedBotToken = botToken
  return cachedSession
}

/**
 * Quick credential probe used by the health check. Calls `auth.test` which
 * is the canonical "is this token still valid" endpoint per the Slack docs.
 */
export async function validateCredentials(context: SecretsContext): Promise<void> {
  const { client } = await getSlackSession(context)
  const result = await client.auth.test()
  if (!result.ok) {
    throw new Error(`Slack auth.test failed: ${result.error ?? "unknown"}`)
  }
}
