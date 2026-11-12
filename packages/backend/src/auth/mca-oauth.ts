/**
 * MCA OAuth Service
 *
 * Handles OAuth flows for MCA (Model Context Apps) authentication.
 * Different from GoogleAuth (login) - this is for connecting user accounts to apps.
 *
 * Flow:
 * 1. User clicks "Connect with Google" on Gmail app
 * 2. generateAuthUrl() creates OAuth URL with state containing appId, userId, mcaId
 * 3. User authorizes in Google
 * 4. handleCallback() exchanges code for tokens
 * 5. Tokens stored in user_credentials via AuthManager (encrypted)
 * 6. App now has access to user's Gmail
 */

import type {
  ApiKeyField,
  AppAuthInfo,
  AppCredentialStatus,
  GitHubInstallationSummary,
  GitHubSavedBranch,
  McaAuthType,
  McaOAuthState,
  OAuthTokenResponse,
} from "@teros/core"
import { readFile } from "fs/promises"
import { join } from "path"
import { config } from "../config"
import { COLLECTIONS, collection, ensureCollectionIndexes } from "../db"
import { createHash, randomBytes } from "crypto"
import { type Collection, type Db, ObjectId } from "mongodb"
import { HttpClient } from "../lib/HttpClient"
import { createLogger } from "../lib/logger"
import type { SecretsManager } from "../secrets/secrets-manager"
import type { App, McpCatalogEntry } from "../types/database"
import type { AuthManager } from "./auth-manager"

const log = createLogger("McaOAuth")

// Shared HTTP client for all OAuth token/userinfo exchanges
const oauthHttpClient = new HttpClient({
  timeout: 15_000,
  maxRetries: 1,
  retryStatusCodes: [429, 503, 504],
  logging: false,
  logLabel: "McaOAuth",
})

// Known OAuth provider configurations
/**
 * Token response shape that providers may extend with their own fields.
 * Slack's `oauth.v2.access` ships `team`, `authed_user`, etc. inline.
 */
type ProviderTokenResponse = OAuthTokenResponse & Record<string, unknown>

/**
 * Per-provider OAuth configuration. Two discriminated `kind`s based on how
 * the provider exposes user identity:
 *
 *  - `"url-based"` (Google, GitHub, Microsoft, Canva, ClickUp, Notion, Figma):
 *    canonical OAuth2 flow with a separate userInfo endpoint.
 *  - `"token-inline"` (Slack): provider ships identity directly inside the
 *    token exchange response, so a separate GET is not the canonical path.
 *
 * Optional hooks (apply to both kinds) — use these instead of `if (provider
 * === "x")` branches in the handler:
 *
 *  - `requestRefreshToken`: append Google-style `access_type=offline` /
 *    `prompt=consent` to the authorize URL.
 *  - `basicAuth`: use Basic Auth for the token endpoint (Notion, Figma).
 *  - `customizeAuthorizeParams(params)`: mutate the URLSearchParams before
 *    building the authorize URL (Slack moves `scope` → `user_scope`).
 *  - `extraCredentials(token)`: derive provider-specific credential fields
 *    from the token response (Slack `TEAM_ID`, `TEAM_NAME`, `USER_ID`).
 */
type OAuthProviderBase = {
  basicAuth?: boolean
  requestRefreshToken?: boolean
  customizeAuthorizeParams?: (params: URLSearchParams) => void
  extraCredentials?: (token: ProviderTokenResponse) => Record<string, string | undefined>
}

type UrlBasedProvider = OAuthProviderBase & {
  kind: "url-based"
  userInfoUrl: string
  userInfoFields: { email: string; name?: string }
  userInfoHeaders?: Record<string, string>
  emailFallbackFields?: string[]
}

type TokenInlineProvider = OAuthProviderBase & {
  kind: "token-inline"
  getUserInfo: (
    token: ProviderTokenResponse,
    http: HttpClient,
  ) => Promise<{ email?: string; name?: string }>
}

export type OAuthProviderConfig = UrlBasedProvider | TokenInlineProvider

export const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  google: {
    kind: "url-based",
    userInfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    userInfoFields: { email: "email", name: "name" },
    requestRefreshToken: true,
  },
  github: {
    kind: "url-based",
    userInfoUrl: "https://api.github.com/user",
    userInfoFields: { email: "email", name: "login" },
    // GitHub App: login is more reliable than name (name can be null)
    requestRefreshToken: true,
  },
  microsoft: {
    kind: "url-based",
    userInfoUrl: "https://graph.microsoft.com/v1.0/me",
    userInfoFields: { email: "mail", name: "displayName" },
    emailFallbackFields: ["userPrincipalName"],
    // Microsoft issues refresh tokens via the `offline_access` scope (present
    // in all Microsoft MCA manifests) — the Google-style `access_type=offline`
    // / `prompt=consent` params are not needed and are actively harmful:
    // `prompt=consent` forces an interactive user-consent screen on every
    // login, ignoring admin consent already granted for the organization. In
    // tenants where user consent is disabled (common in corporate Microsoft
    // 365), users get stuck at "admin approval required" even though the
    // admin already consented.
    requestRefreshToken: false,
    // Always show the account picker so each user selects their own account
    // instead of silently reusing whatever session is open in the browser
    // (e.g. an IT admin who logged in earlier to approve consent).
    customizeAuthorizeParams: (params) => {
      params.set("prompt", "select_account")
    },
  },
  canva: {
    kind: "url-based",
    userInfoUrl: "https://api.canva.com/rest/v1/users/me/profile",
    userInfoFields: { email: "display_name", name: "display_name" }, // Canva doesn't expose email, use display_name
    requestRefreshToken: true,
  },
  clickup: {
    kind: "url-based",
    userInfoUrl: "https://api.clickup.com/api/v2/user",
    userInfoFields: { email: "email", name: "username" },
    requestRefreshToken: true,
  },
  notion: {
    kind: "url-based",
    userInfoUrl: "https://api.notion.com/v1/users/me",
    userInfoFields: { email: "email", name: "name" },
    userInfoHeaders: { "Notion-Version": "2026-03-11" },
    basicAuth: true, // Notion requires Basic Auth for token exchange
    requestRefreshToken: true,
  },
  figma: {
    kind: "url-based",
    userInfoUrl: "https://api.figma.com/v1/me",
    userInfoFields: { email: "email", name: "handle" }, // Figma exposes handle, not name
    basicAuth: true, // Figma requires Basic Auth for token exchange
    requestRefreshToken: true,
  },
  slack: {
    kind: "token-inline",
    // Slack oauth.v2.access returns:
    //   { ok, access_token (bot, "xoxb-..."), scope, team: { id, name },
    //     authed_user: { id, scope, access_token (user, "xoxp-..."), token_type } }
    //
    // Slack splits scopes into two taxonomies (verified against
    // https://docs.slack.dev/reference/scopes — "Supported token types" column):
    //   - User Token Scopes (channels:read, im:write, dnd:write, ...)
    //   - Bot Token Scopes (channels:manage, conversations.connect:*, remote_files:*, ...)
    //
    // The manifest ships a flat scopes[] list. The hook below partitions it
    // and emits BOTH `scope=` (bot scopes) AND `user_scope=` (user scopes) so
    // Slack returns both tokens. `extraCredentials` then persists each one as
    // ACCESS_TOKEN (user) + BOT_ACCESS_TOKEN (bot). Tools that need bot-only
    // scopes (~11 in the catalog) consume `session.botClient`.
    //
    // Scopes verified bot-only (must NOT go in user_scope):
    customizeAuthorizeParams: (params) => {
      const scopes = params.get("scope")
      if (!scopes) return
      // Slack scope buckets (verified against docs.slack.dev/reference/scopes
      // "Supported token types" + observed against la app "Teros Dev" del workspace).
      //
      // BOT_ONLY: scope que la app declara en Bot Token Scopes pero NO en User.
      // Se manda solo en `scope=`.
      const SLACK_BOT_ONLY = new Set([
        "app_mentions:read",
        "assistant:write",
        "channels:join",
        "channels:manage",
        "chat:write.customize",
        "chat:write.public",
        "commands",
        "incoming-webhook",
        "links.embed:write",
        "workflow.steps:execute",
        "workflows.templates:read",
        "workflows.templates:write",
        "conversations.connect:manage",
        "conversations.connect:read",
        "conversations.connect:write",
        "remote_files:write",
      ])
      // BOTH: scope que la app declara EN AMBOS bot + user (Slack lo expone
      // como "Supported token types: Bot, User, Legacy Bot"). Si solo lo
      // mandamos en uno de los dos buckets y la app lo exige obligatorio en
      // ambos, Slack rechaza el OAuth con "permisos no válidos".
      //
      // Lista verificada contra:
      //   - docs.slack.dev/reference/scopes/<name> "Supported token types".
      //   - Estado actual de "Teros Dev" app (scopes obligatorios).
      const SLACK_BOTH = new Set([
        "chat:write",
        "remote_files:read",
        "remote_files:share",
        "links:write",
      ])
      const all = scopes.split(" ").filter(Boolean)
      const botScopes = all
        .filter((s) => SLACK_BOT_ONLY.has(s) || SLACK_BOTH.has(s))
        .join(" ")
      const userScopes = all
        .filter((s) => !SLACK_BOT_ONLY.has(s) || SLACK_BOTH.has(s))
        .join(" ")
      params.set("user_scope", userScopes)
      if (botScopes) {
        params.set("scope", botScopes)
      } else {
        params.delete("scope")
      }
    },
    // Persist team/user identifiers + DUAL tokens (bot + user) from the token
    // response. Slack ships both:
    //   - `access_token` ("xoxb-...") → bot identity, drives channels:manage,
    //     conversations.connect:*, remote_files:*, etc.
    //   - `authed_user.access_token` ("xoxp-...") → user identity, drives most
    //     read/mutation tools (channels:read, im:write, dnd:write, ...).
    //
    // Both are persisted; the MCA's slack-client.ts builds two WebClients
    // (`session.client` user + `session.botClient` bot) and tools pick the
    // right one. When the install only granted a user token (no bot scopes
    // requested), BOT_ACCESS_TOKEN is omitted and botClient falls back to
    // client at the MCA layer.
    extraCredentials: (token) => {
      const out: Record<string, string | undefined> = {}
      const team = token.team as { id?: string; name?: string } | undefined
      const authedUser = token.authed_user as { id?: string; access_token?: string } | undefined
      const botToken = typeof token.access_token === "string" ? token.access_token : undefined
      if (team?.id) out.TEAM_ID = team.id
      if (team?.name) out.TEAM_NAME = team.name
      if (authedUser?.id) out.USER_ID = authedUser.id
      // ACCESS_TOKEN is the user-scoped token (consumed by `session.client`).
      if (authedUser?.access_token) out.ACCESS_TOKEN = authedUser.access_token
      // BOT_ACCESS_TOKEN is the bot-scoped token (consumed by `session.botClient`).
      // Omitted when Slack only returned a user token (install without bot scopes).
      if (botToken && botToken.startsWith("xoxb-")) out.BOT_ACCESS_TOKEN = botToken
      return out
    },
    // Fetch full profile (email, real_name) via users.info using the
    // user-scoped access_token (scopes users:read + users:read.email).
    getUserInfo: async (token, http) => {
      const team = token.team as { name?: string } | undefined
      const authedUser = token.authed_user as
        | { id?: string; access_token?: string }
        | undefined
      const userId = authedUser?.id
      const userToken = authedUser?.access_token ?? token.access_token
      if (!userId || !userToken) return { name: team?.name }
      try {
        const resp = await http.get<{
          ok: boolean
          user?: { name?: string; profile?: { email?: string; real_name?: string } }
        }>(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
          headers: {
            Authorization: `Bearer ${userToken}`,
            Accept: "application/json",
          },
        })
        if (resp.ok && resp.user) {
          return {
            email: resp.user.profile?.email,
            name: resp.user.profile?.real_name ?? resp.user.name ?? team?.name,
          }
        }
      } catch (e) {
        console.warn("[McaOAuth] Slack users.info failed:", e)
      }
      return { name: team?.name }
    },
  },
}

// State token expiration (10 minutes)
const STATE_EXPIRATION_MS = 10 * 60 * 1000

/**
 * MongoDB document for MCA OAuth state
 */
export interface McaOAuthStateDocument {
  _id: ObjectId
  state: string
  appId: string
  userId: string
  mcaId: string
  provider: string
  codeVerifier?: string // For PKCE flow
  expiresAt: Date
  createdAt: Date
}

/**
 * Build the headers + body for an OAuth2 token-endpoint POST applying the
 * correct client-authentication method. Providers flagged `basicAuth`
 * (Notion, Figma) and PKCE flows authenticate via the `Authorization: Basic`
 * header with NO creds in the body; everyone else puts client_id/client_secret
 * in the body. Shared by `exchangeCode` and `refreshToken` so the two CANNOT
 * diverge — that divergence (refresh sending creds in the body for basicAuth
 * providers) was the bug TER-464 fixed.
 */
export function buildTokenRequest(
  baseParams: Record<string, string>,
  opts: { clientId: string; clientSecret?: string; useBasicAuth: boolean; codeVerifier?: string },
): { headers: Record<string, string>; body: URLSearchParams } {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  }
  const bodyParams: Record<string, string> = { ...baseParams }

  if (opts.useBasicAuth) {
    const clientSecret = opts.clientSecret ?? ""
    const credentials = Buffer.from(`${opts.clientId}:${clientSecret}`).toString("base64")
    headers["Authorization"] = `Basic ${credentials}`
  } else {
    bodyParams.client_id = opts.clientId
    if (opts.clientSecret) {
      bodyParams.client_secret = opts.clientSecret
    }
  }

  if (opts.codeVerifier) {
    bodyParams.code_verifier = opts.codeVerifier
  }

  return { headers, body: new URLSearchParams(bodyParams) }
}

function tokenResponseError(tokens: ProviderTokenResponse): string | undefined {
  if (tokens.error != null || tokens.ok === false) return String(tokens.error ?? "ok: false")
  return undefined
}

type GitHubInstallationLookup =
  | { kind: "ok"; installations: GitHubInstallationSummary[] }
  | { kind: "unauthorized" }
  | { kind: "unknown" }

const GITHUB_INSTALLATION_CACHE_MS = 5 * 60 * 1000
const githubInstallationCache = new Map<string, { at: number; value: GitHubInstallationLookup }>()

export function clearGitHubInstallationCache(): void {
  githubInstallationCache.clear()
}

function pendingGitHubPermissions(wanted: Record<string, string>, granted: Record<string, string> | undefined): string[] {
  return Object.entries(wanted)
    .filter(([key, level]) => {
      const has = granted?.[key]
      return !has || (level === "write" && has !== "write" && has !== "admin")
    })
    .map(([key]) => key)
}

async function fetchGitHubInstallations(token: string, wanted: Record<string, string>): Promise<GitHubInstallationLookup> {
  try {
    const res = await fetch("https://api.github.com/user/installations?per_page=100", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Teros",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(5_000),
    })
    if (res.status === 401) return { kind: "unauthorized" }
    if (!res.ok) return { kind: "unknown" }
    const body = (await res.json()) as {
      installations?: Array<{
        id: number
        account?: { login?: string; type?: string }
        html_url?: string
        permissions?: Record<string, string>
        suspended_at?: string | null
      }>
    }
    return {
      kind: "ok",
      installations: (body.installations ?? []).map((i) => {
        const pending = pendingGitHubPermissions(wanted, i.permissions)
        return {
          id: String(i.id),
          account: i.account?.login ?? "",
          ...(i.account?.type ? { accountType: i.account.type } : {}),
          ...(i.html_url ? { manageUrl: i.html_url } : {}),
          ...(i.suspended_at ? { suspended: true } : {}),
          ...(pending.length > 0 ? { pendingPermissions: pending } : {}),
        }
      }),
    }
  } catch {
    return { kind: "unknown" }
  }
}

async function cachedGitHubInstallations(
  key: string,
  token: string,
  wanted: Record<string, string>,
): Promise<GitHubInstallationLookup> {
  const hit = githubInstallationCache.get(key)
  if (hit && Date.now() - hit.at < GITHUB_INSTALLATION_CACHE_MS) return hit.value
  const value = await fetchGitHubInstallations(token, wanted)
  if (value.kind !== "unknown") githubInstallationCache.set(key, { at: Date.now(), value })
  return value
}

export class McaOAuth {
  private statesCollection: Collection<McaOAuthStateDocument>
  private refreshesInFlight = new Map<string, Promise<{ success: boolean; error?: string }>>()
  private connectionManager?: {
    sendCredentialsUpdate: (appId: string, credentials: Record<string, string>) => boolean
  }
  /**
   * v2 non-blocking interactions: fired from handleCallback when a user's
   * OAuth flow completes (auth state → ready). The backend wires this to wake
   * the channel whose agent asked the user to connect the app ("the user
   * connected X — you can continue"). show-app-auth registers the
   * (userId, appId) → channelId mapping in an awaiting-auth registry; this
   * hook consumes it. Without the hook (legacy/tests) the callback just
   * doesn't wake anyone — same as v1.
   */
  private onAppAuthReady?: (userId: string, appId: string) => void

  constructor(
    private db: Db,
    private authManager: AuthManager,
    private secretsManager: SecretsManager,
    private catalogCollection: Collection<McpCatalogEntry>,
  ) {
    this.statesCollection = db.collection<McaOAuthStateDocument>("mca_oauth_states")
  }

  /**
   * Set the MCA Connection Manager for notifying MCAs of credential updates
   */
  setConnectionManager(connectionManager: {
    sendCredentialsUpdate: (appId: string, credentials: Record<string, string>) => boolean
  }): void {
    this.connectionManager = connectionManager
  }

  /** v2 non-blocking interactions: wire the auth-ready wake hook (see field). */
  setOnAppAuthReady(hook: (userId: string, appId: string) => void): void {
    this.onAppAuthReady = hook
  }

  /**
   * Initialize indexes for the states collection
   */
  async ensureIndexes(): Promise<void> {
    // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry with
    // ensureAllIndexes after migrations. Kept for tests and scripts.
    await ensureCollectionIndexes(this.statesCollection, COLLECTIONS.mcaOauthStates)
  }

  /**
   * Generate OAuth authorization URL for an app
   */
  async generateAuthUrl(
    appId: string,
    userId: string,
    mcaId: string,
    redirectUri: string,
  ): Promise<{ url: string; state: string }> {
    // 1. Get MCA from catalog
    const mca = await this.catalogCollection.findOne({ mcaId: mcaId })
    if (!mca) {
      throw new Error(`MCA ${mcaId} not found in catalog`)
    }

    // 2. Validate MCA has supported auth config
    const authConfig = mca.auth || (mca.authSchema as any)?.auth
    if (!authConfig || (authConfig.type !== "oauth2" && authConfig.type !== "oauth" && authConfig.type !== "github-app")) {
      throw new Error(`MCA ${mcaId} does not support OAuth or GitHub App auth`)
    }

    // 3. Load client credentials from secrets.
    //    - oauth2 / oauth: needs CLIENT_ID in systemSecrets. CLIENT_SECRET is
    //      required for confidential clients; public PKCE clients (e.g. Plaud)
    //      omit it (token_endpoint_auth_method = "none").
    //    - github-app + userOAuth: needs GITHUB_APP_CLIENT_ID + GITHUB_APP_CLIENT_SECRET
    //      (the install URL itself is public, but the callback will need them
    //      to exchange the user code for a user_access_token).
    //    - github-app installation-only: install URL is public; no client
    //      credentials needed for generating the auth URL.
    const secrets = this.secretsManager.mca(mcaId)
    if (authConfig.type === "oauth2" || authConfig.type === "oauth") {
      const clientId = secrets?.CLIENT_ID
      const clientSecret = secrets?.CLIENT_SECRET
      if (!clientId) {
        throw new Error(`OAuth client_id not configured for ${mcaId} (set CLIENT_ID in .secrets/mcas/${mcaId}/credentials.json)`)
      }
      // Public PKCE clients do not require a client_secret.
      if (!clientSecret && authConfig.pkce !== true) {
        throw new Error(`OAuth client credentials not configured for ${mcaId}`)
      }
    } else if (authConfig.type === "github-app" && (authConfig as { userOAuth?: boolean }).userOAuth) {
      if (
        !(secrets as Record<string, string | undefined> | undefined)?.GITHUB_APP_CLIENT_ID ||
        !(secrets as Record<string, string | undefined> | undefined)?.GITHUB_APP_CLIENT_SECRET
      ) {
        throw new Error(
          `GitHub App user-OAuth requires GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET secrets for ${mcaId}`,
        )
      }
    }

    // 4. Generate state token
    const state = randomBytes(32).toString("base64url")
    const provider = authConfig.provider || "custom"

    // 5. Generate PKCE code verifier if required
    let codeVerifier: string | undefined
    let codeChallenge: string | undefined

    if (authConfig.pkce) {
      // Generate code_verifier: 43-128 characters, URL-safe
      codeVerifier = randomBytes(64).toString("base64url")
      // Generate code_challenge: SHA-256 hash of verifier, base64url encoded
      codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url")
    }

    // 6. Store state in database (including codeVerifier for PKCE)
    await this.statesCollection.insertOne({
      _id: new ObjectId(),
      state,
      appId,
      userId,
      mcaId,
      provider,
      codeVerifier, // Store for token exchange
      expiresAt: new Date(Date.now() + STATE_EXPIRATION_MS),
      createdAt: new Date(),
    })

    // 7. Build authorization URL
    let url: string
    if (authConfig.type === "github-app") {
      // Slug resolution: prefer `GITHUB_APP_SLUG` from systemSecrets (env-specific:
      // `teros-dev-romero` in dev, `teros` in prod) over the manifest value (which
      // is a sane default committed to git).
      const slug =
        (secrets as { GITHUB_APP_SLUG?: string } | undefined)?.GITHUB_APP_SLUG ??
        (authConfig as { appSlug?: string }).appSlug
      if (!slug) {
        throw new Error(`MCA ${mcaId} is github-app but missing appSlug (manifest) and GITHUB_APP_SLUG (secrets)`)
      }

      if ((authConfig as { userOAuth?: boolean }).userOAuth) {
        // user-to-server: start at OAuth authorize URL. If the App is not
        // installed on the user's account, GitHub will offer "Install &
        // Authorize" combined; if it's already installed (e.g. previous
        // setup flow on the same account), GitHub only asks for user
        // authorization and skips the install picker. Either way GitHub
        // redirects to the Callback URL with `code + state +
        // installation_id`, which `handleCallback` exchanges for a
        // user_access_token.
        const clientId = (secrets as { GITHUB_APP_CLIENT_ID?: string } | undefined)?.GITHUB_APP_CLIENT_ID
        if (!clientId) {
          throw new Error(`MCA ${mcaId} is github-app userOAuth=true but missing GITHUB_APP_CLIENT_ID secret`)
        }
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          state,
        })
        url = `https://github.com/login/oauth/authorize?${params.toString()}`
      } else {
        // Server-to-server only (legacy): pure install URL. GitHub redirects
        // back with `installation_id + state` (no `code`); the Setup URL
        // handler dispatches to `GitHubAppService.handleInstallation`.
        url = `https://github.com/apps/${slug}/installations/new?state=${state}`
      }
    } else if (provider === "github" && authConfig.authorizeUrl?.includes("/apps/")) {
      // Legacy GitHub App URL stored in `authorizeUrl` — kept for backwards
      // compat with manifests not yet migrated to `auth.type: 'github-app'`.
      url = `${authConfig.authorizeUrl}?state=${state}`
    } else {
      const clientId = secrets!.CLIENT_ID
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: (authConfig.scopes || []).join(authConfig.scopeSeparator || " "),
        state,
      })

      // HubSpot-style optional scopes — user can grant/deny individually
      if (authConfig.optionalScopes && authConfig.optionalScopes.length > 0) {
        params.append(
          "optional_scope",
          authConfig.optionalScopes.join(authConfig.scopeSeparator || " ")
        )
      }

      const providerCfg = OAUTH_PROVIDERS[provider]

      if (codeChallenge) {
        // PKCE flow: client-side challenge replaces refresh-token negotiation.
        params.append("code_challenge", codeChallenge)
        params.append("code_challenge_method", "S256")
      } else if (providerCfg?.requestRefreshToken) {
        // Google-style: ask explicitly for an offline refresh token. Opt-in
        // per provider — Slack OAuth v2 rejects `access_type=offline`.
        params.append("access_type", "offline")
        params.append("prompt", "consent")
      }

      // Per-provider tweak to the authorize URL params (e.g. Slack moves
      // scopes to `user_scope`).
      providerCfg?.customizeAuthorizeParams?.(params)

      url = `${authConfig.authorizeUrl}?${params.toString()}`
      log.debug({ provider, mcaId }, "Authorize URL generated")
      log.debug({ scope: params.get("scope") || "(none)" }, "OAuth scope")
      log.debug({ userScope: params.get("user_scope") || "(none)" }, "OAuth user_scope")
    }

    return { url, state }
  }

  /**
   * Read a state document WITHOUT consuming it. Useful for the HTTP handler
   * to dispatch to a different processor (e.g. github-app vs oauth2) before
   * the state is committed.
   */
  async peekState(state: string): Promise<McaOAuthStateDocument | null> {
    return this.statesCollection.findOne({
      state,
      expiresAt: { $gt: new Date() },
    })
  }

  /**
   * Atomically read+delete a state document. Used by both the OAuth callback
   * and `GitHubAppService.handleInstallation`.
   */
  async consumeState(state: string): Promise<McaOAuthStateDocument | null> {
    return this.statesCollection.findOneAndDelete({
      state,
      expiresAt: { $gt: new Date() },
    })
  }

  /**
   * Handle OAuth callback - exchange code for tokens
   */
  async handleCallback(
    code: string,
    state: string,
    redirectUri: string,
    extraParams?: Record<string, string>,
  ): Promise<{ success: boolean; appId?: string; error?: string }> {
    // 1. Validate state
    const stateDoc = await this.consumeState(state)

    if (!stateDoc) {
      return { success: false, error: "Invalid or expired state token" }
    }

    try {
      // 2. Get MCA config
      const mca = await this.catalogCollection.findOne({ mcaId: stateDoc.mcaId })
      if (!mca) {
        return { success: false, error: "MCA not found" }
      }

      const authConfig = mca.auth || (mca.authSchema as any)?.auth
      const secrets = this.secretsManager.mca(stateDoc.mcaId)

      // GitHub App in user-to-server mode keeps its OAuth credentials under
      // GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET (the same naming used
      // by the installation token resolver). Standard OAuth2 MCAs use
      // CLIENT_ID / CLIENT_SECRET. Resolve the right pair here.
      const isGithubAppUserOAuth =
        authConfig?.type === "github-app" && authConfig?.userOAuth === true
      const clientId = isGithubAppUserOAuth
        ? secrets!.GITHUB_APP_CLIENT_ID
        : secrets!.CLIENT_ID
      const clientSecret = isGithubAppUserOAuth
        ? secrets!.GITHUB_APP_CLIENT_SECRET
        : secrets!.CLIENT_SECRET

      // Plaud MCP uses a public PKCE client: client_secret is optional.
      // If the manifest declares `pkce: true` and no secret is configured,
      // send the token request without client_secret (token_endpoint_auth_method = none).
      const effectiveClientSecret = clientSecret || (authConfig.pkce === true ? undefined : clientSecret)

      // 3. Exchange code for tokens
      // Basic Auth is only enabled for providers explicitly flagged (Notion/Figma).
      // PKCE public clients (e.g. Plaud) send client_id in the body and no secret.
      const providerBasicAuth = OAUTH_PROVIDERS[stateDoc.provider]?.basicAuth === true
      const tokens = await this.exchangeCode(code, {
        tokenUrl: authConfig.tokenUrl,
        clientId,
        clientSecret: effectiveClientSecret,
        redirectUri,
        codeVerifier: stateDoc.codeVerifier, // For PKCE flow
        usePkce: authConfig.pkce === true,
        useBasicAuth: providerBasicAuth,
      })

      // 4. Get user info (provider-specific path)
      let email: string | undefined
      let userLogin: string | undefined
      const providerConfig = OAUTH_PROVIDERS[stateDoc.provider]
      const tokensExt = tokens as ProviderTokenResponse
      if (providerConfig) {
        try {
          if (providerConfig.kind === "token-inline") {
            // Identity comes from the token response itself (Slack).
            const info = await providerConfig.getUserInfo(tokensExt, oauthHttpClient)
            email = info.email
            userLogin = info.name
          } else {
            // url-based: canonical OAuth2 with separate userInfo endpoint.
            const userInfo = await this.getUserInfo(
              providerConfig.userInfoUrl,
              tokens.access_token,
              providerConfig.userInfoHeaders,
            )
            email = userInfo[providerConfig.userInfoFields.email]
            // Fallback fields if primary email field is null (e.g. Microsoft's 'mail' vs 'userPrincipalName')
            if (!email && providerConfig.emailFallbackFields) {
              for (const field of providerConfig.emailFallbackFields) {
                if (userInfo[field]) {
                  email = userInfo[field]
                  break
                }
              }
            }
            // Capture login/handle (GitHub `login`, Notion `name`, etc.) when defined.
            if (providerConfig.userInfoFields.name) {
              const candidate = userInfo[providerConfig.userInfoFields.name]
              if (typeof candidate === "string" && candidate.length > 0) {
                userLogin = candidate
              }
            }
          }
        } catch (e) {
          console.warn(`[McaOAuth] Failed to get user info:`, e)
          // Continue without email - not critical
        }
      }

      // 5. Calculate expiry
      const expiryDate = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : undefined

      // 6. Store credentials via AuthManager (encrypted)
      const credentials: Record<string, string | undefined> = {
        ACCESS_TOKEN: tokens.access_token,
        REFRESH_TOKEN: tokens.refresh_token,
        EXPIRY_DATE: expiryDate,
        EMAIL: email,
      }

      // Persist the scopes the provider actually granted, when it returns them
      // in the token response, so we know what a given account authorized (with
      // optional scopes the account lacks silently dropped). Providers vary in
      // shape: OAuth2-standard ships `scope` (space-delimited string), HubSpot
      // ships `scopes` (array of strings). Normalize both → space-delimited string.
      // Multi-provider, not HubSpot-only. Diagnostic + lets the UI surface grants.
      const rawScopes =
        (tokensExt as { scope?: unknown }).scope ?? (tokensExt as { scopes?: unknown }).scopes
      const grantedScopes = Array.isArray(rawScopes)
        ? rawScopes.filter((s): s is string => typeof s === "string").join(" ")
        : typeof rawScopes === "string"
          ? rawScopes
          : ""
      if (grantedScopes.length > 0) {
        credentials.GRANTED_SCOPES = grantedScopes
        log.info(
          { provider: stateDoc.provider, mcaId: stateDoc.mcaId, grantedScopes },
          "Granted scopes",
        )
      }

      // GitHub App user-to-server: persist user-specific tokens under
      // explicit names so the MCA client can pick them up. INSTALLATION_ID is
      // also captured below from extraParams.
      if (isGithubAppUserOAuth) {
        credentials.USER_ACCESS_TOKEN = tokens.access_token
        credentials.USER_REFRESH_TOKEN = tokens.refresh_token
        credentials.USER_TOKEN_EXPIRES_AT = expiryDate
        credentials.USER_LOGIN = userLogin
      }

      // GitHub App: capture installation_id from callback params
      // When a user installs a GitHub App, GitHub redirects with ?installation_id=xxx&code=yyy
      if (stateDoc.provider === "github" && extraParams?.installation_id) {
        credentials.INSTALLATION_ID = extraParams.installation_id
        log.info({ installationId: extraParams.installation_id }, "GitHub App installation_id captured")
      }

      // QuickBooks (Intuit): capture realmId from callback params
      if (extraParams?.realmId) {
        credentials.REALM_ID = extraParams.realmId
        log.info({ realmId: extraParams.realmId }, "QuickBooks realmId captured")
      }

      // Provider-specific credentials extracted from the token response
      // (Slack TEAM_ID/TEAM_NAME/USER_ID + user-scoped ACCESS_TOKEN override).
      if (providerConfig?.extraCredentials) {
        Object.assign(credentials, providerConfig.extraCredentials(tokensExt))
      }

      if (!credentials.ACCESS_TOKEN) {
        throw new Error("Token exchange failed: no access_token in response")
      }

      if (stateDoc.provider === "github" && !credentials.INSTALLATION_ID) {
        const previous = await this.authManager.get(stateDoc.userId, stateDoc.appId)
        if (previous?.INSTALLATION_ID) credentials.INSTALLATION_ID = previous.INSTALLATION_ID
      }

      await this.authManager.set(stateDoc.userId, stateDoc.appId, stateDoc.mcaId, credentials)


      // 7. Notify MCA via WebSocket if connected
      if (this.connectionManager) {
        const sent = this.connectionManager.sendCredentialsUpdate(
          stateDoc.appId,
          credentials as Record<string, string>,
        )
        if (sent) {
          log.info({ appId: stateDoc.appId }, "Notified MCA of new credentials")
        } else {
          log.info(
            { appId: stateDoc.appId },
            "MCA not connected, credentials will be loaded on next spawn",
          )
        }
      }

      // 8. v2 non-blocking interactions: the auth state just became ready —
      // wake the channel whose agent showed the auth widget. Fire-and-forget
      // (never let a wake failure fail the OAuth callback itself).
      if (this.onAppAuthReady) {
        try {
          this.onAppAuthReady(stateDoc.userId, stateDoc.appId)
        } catch (err) {
          console.error("[McaOAuth] onAppAuthReady (wake) failed:", err)
        }
      }

      return { success: true, appId: stateDoc.appId }
    } catch (error) {
      console.error("[McaOAuth] Callback error:", error)
      return {
        success: false,
        error: error instanceof Error ? error.message : "OAuth flow failed",
      }
    }
  }

  /**
   * Exchange authorization code for tokens
   */
  private async exchangeCode(
    code: string,
    config: {
      tokenUrl: string
      clientId: string
      clientSecret?: string
      redirectUri: string
      codeVerifier?: string
      usePkce?: boolean
      useBasicAuth?: boolean
    },
  ): Promise<OAuthTokenResponse> {
    const { headers, body } = buildTokenRequest(
      {
        code,
        grant_type: "authorization_code",
        redirect_uri: config.redirectUri,
      },
      {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        // Basic Auth applies to: providers explicitly flagged (Notion/Figma) AND
        // PKCE CONFIDENTIAL clients (Canva — pkce + a client_secret, TER-464 guard).
        // PKCE PUBLIC clients (Plaud — pkce, NO client_secret) send client_id in the
        // body and MUST NOT use Basic Auth.
        useBasicAuth: config.useBasicAuth === true || (config.usePkce === true && !!config.clientSecret),
        codeVerifier: config.codeVerifier,
      },
    )

    const response = await oauthHttpClient.fetchRaw("POST", config.tokenUrl, body, { headers })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Token exchange failed: ${error}`)
    }

    const tokens = (await response.json()) as ProviderTokenResponse
    const tokenError = tokenResponseError(tokens)
    if (tokenError) {
      throw new Error(`Token exchange failed: ${tokenError}`)
    }
    return tokens
  }

  /**
   * Get user info from OAuth provider
   */
  private async getUserInfo(url: string, accessToken: string, extraHeaders?: Record<string, string>): Promise<Record<string, any>> {
    return oauthHttpClient.get<Record<string, any>>(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...extraHeaders,
      },
    })
  }

  /**
   * Get auth status for an app
   */
  async getAuthStatus(userId: string, appId: string, mca: McpCatalogEntry): Promise<AppAuthInfo> {
    // 1. Determine auth type from manifest
    const authType = this.determineAuthType(mca)

    if (authType === "none") {
      return { status: "not_required", authType: "none" }
    }

    // Agent-managed auth (e.g. WhatsApp pairing code): Teros no almacena
    // credenciales — la sesión la vincula el agente con sus propias tools.
    // El `message` (instructions del manifest) se muestra en la UI.
    if (authType === "agent") {
      return {
        status: "not_required",
        authType: "agent",
        message: (mca.auth as { instructions?: string } | undefined)?.instructions,
      }
    }

    // 2. Check system secrets (required for OAuth client credentials or shared API keys)
    // userSecrets hoisted here because the hybrid-apikey fall-through below
    // needs to check the completeness of the user's own key set.
    const systemSecrets = this.getRequiredSystemSecrets(mca)
    const userSecrets = this.getRequiredUserSecrets(mca)
    // userSecretsOptional:false (manifest override) — user secrets are
    // complementary: mandatory alongside the system secrets, NOT an optional
    // override of the shared credential (e.g. mca.teros.email: MAIL_ACCOUNT
    // is the mailbox identity, the transport secrets are separate). Absent
    // keeps the default hybrid semantics (2026-10-26).
    const userSecretsOptional = mca.userSecretsOptional !== false
    // Alternative groups (api-key MCAs with more than one valid credential
    // combination, e.g. mca.teros.email lab proxy vs direct token):
    // configured = ALL non-grouped secrets present + SOME complete group —
    // not the flat union of every mode's secrets. Evaluated once here and
    // reused by the hybrid fallback in step 3.
    const systemEval = systemSecrets.length > 0 ? this.evaluateSystemSecrets(mca, this.secretsManager.mca(mca.mcaId)) : { configured: true, missing: [] as string[] }
    if (systemSecrets.length > 0) {
      const { configured: systemConfigured, missing: missingSecrets } = systemEval

      if (!systemConfigured) {
        const userAuth = authType === "apikey" ? await this.authManager.get(userId, appId) : undefined
        // Hybrid apikey MCA (system + user secrets): the user's own key fully
        // replaces the shared system key, so a user with a COMPLETE personal
        // key set stays functional even when the shared key is missing — fall
        // through to the user-credentials check below instead of blocking
        // them with needs_system_setup. Users without their own key (or with
        // a partial one) still get the admin-setup message (with the API-key
        // form so they can self-serve). NOT when userSecretsOptional:false —
        // complementary user secrets cannot replace the system secrets.
        const hasCompleteUserAuth =
          authType === "apikey" &&
          userSecretsOptional &&
          !!userAuth &&
          userSecrets.every((key) => !!userAuth[key])
        if (!hasCompleteUserAuth) {
          return {
            status: "needs_system_setup",
            authType,
            message: `Requiere configuracion de admin: ${missingSecrets.join(", ")}`,
            apikey: authType === "apikey" ? {
              configured: !!userAuth,
              fields: this.buildApiKeyFields(mca, userAuth),
            } : undefined,
          }
        }
      }
    }

    // 3. Check user credentials
    if (userSecrets.length > 0) {
      const userAuth = await this.authManager.get(userId, appId)

      if (!userAuth) {
        // Hybrid apikey MCA (system + user secrets, e.g. elevenlabs/twilio):
        // the system secrets are a VALID shared fallback, so a user without
        // their own key is still functional — the user secret is an optional
        // override, not a requirement. Only report needs_user_auth when the
        // system fallback is ALSO unusable (missing system secrets), i.e.
        // there is genuinely no way to call the provider.
        //
        // Decision (2026-10-26, user-secrets post-demo migration): generic
        // rule — authType 'apikey' + all system secrets present → 'ready'
        // with apikey.configured=false + fields so the UI still renders the
        // optional-key form. No manifest flag needed: for apikey MCAs the
        // presence of system secrets IS the "userSecretsOptional" signal.
        // OAuth2/github-app MCAs are unaffected (their system secrets are
        // client credentials, not a usable fallback).
        //
        // userSecretsOptional:false (manifest override) flips this to
        // complementary semantics: the user secrets are mandatory even with
        // complete system secrets (e.g. mca.teros.email — MAIL_ACCOUNT is the
        // mailbox identity, not an override of the transport credentials), so
        // fall through to needs_user_auth instead of the fake 'ready'.
        if (authType === "apikey" && systemSecrets.length > 0 && userSecretsOptional) {
          if (systemEval.configured) {
            return {
              status: "ready",
              authType,
              apikey: {
                configured: false,
                fields: this.buildApiKeyFields(mca),
              },
              message: "App funcional con la credencial compartida — configura tu propia API key para usar tu cuenta",
            }
          }
        }

        return this.buildNeedsAuthResponse(mca, authType)
      }

      // userSecretsRequired (api-key only): a record that exists but lacks
      // the MANDATORY user secrets is still needs_user_auth — e.g.
      // mca.teros.email with MAIL_FROM_NAME set but no MAIL_ACCOUNT (the
      // mailbox identity) is not operational. Absent = all declared
      // userSecrets are mandatory (the historic rule), so flat MCAs are
      // unchanged.
      if (authType === "apikey") {
        const mandatory = mca.userSecretsRequired && mca.userSecretsRequired.length > 0 ? mca.userSecretsRequired : userSecrets
        const missingUser = mandatory.filter((key) => !userAuth[key])
        if (missingUser.length > 0) {
          return {
            status: "needs_user_auth",
            authType,
            apikey: {
              configured: true,
              fields: this.buildApiKeyFields(mca, userAuth),
            },
            message: `Faltan secrets del usuario: ${missingUser.join(", ")}`,
          }
        }
      }

      // GitHub App in user-OAuth mode: re-auth obligatoria si el user solo
      // tiene INSTALLATION_ID (legacy) pero no USER_ACCESS_TOKEN.
      const isGhAppUserOAuth =
        authType === "github-app" && (mca.auth as { userOAuth?: boolean })?.userOAuth === true
      if (isGhAppUserOAuth && !userAuth.USER_ACCESS_TOKEN) {
        return {
          status: "expired",
          authType,
          oauth: {
            provider: this.getOAuthProvider(mca),
            connected: false,
            extraFields: this.buildExtraFields(mca, userAuth),
          },
          message:
            "Reconecta tu cuenta de GitHub para que las acciones aparezcan firmadas con tu identidad",
        }
      }

      // 4. Check token expiry for OAuth and auto-refresh if needed
      // (oauth2, or github-app with userOAuth=true — both store EXPIRY_DATE)
      if ((authType === "oauth2" || isGhAppUserOAuth) && userAuth.EXPIRY_DATE) {
        const expiry = new Date(userAuth.EXPIRY_DATE)
        const now = new Date()
        // Add 5 minute buffer - refresh if expiring soon
        const expiryBuffer = new Date(now.getTime() + 5 * 60 * 1000)

        if (expiry < expiryBuffer) {
          // Token expired or expiring soon - try to refresh
          if (userAuth.REFRESH_TOKEN) {
            log.info({ appId }, "Token expired/expiring, attempting refresh")
            const refreshResult = await this.refreshToken(userId, appId, mca.mcaId)

            if (refreshResult.success) {
              log.info({ appId }, "Token refreshed successfully")
              // Get updated credentials after refresh
              const updatedAuth = await this.authManager.get(userId, appId)
              const refreshed: AppAuthInfo = {
                status: "ready",
                authType,
                oauth: {
                  provider: this.getOAuthProvider(mca),
                  connected: true,
                  email: updatedAuth?.EMAIL,
                  userLogin: updatedAuth?.USER_LOGIN,
                  expiresAt: updatedAuth?.EXPIRY_DATE,
                  extraFields: this.buildExtraFields(mca, updatedAuth),
                },
                githubApp: isGhAppUserOAuth
                  ? {
                      installed: true,
                      appSlug: this.resolveAppSlug(mca),
                      installationId: updatedAuth?.INSTALLATION_ID,
                    }
                  : undefined,
              }
              return isGhAppUserOAuth && updatedAuth
                ? this.withGitHubInstallations(refreshed, userId, appId, mca, updatedAuth)
                : refreshed
            } else {
              console.warn(`[McaOAuth] Token refresh failed for ${appId}: ${refreshResult.error}`)
              // Refresh failed - token is truly expired
              return {
                status: "expired",
                authType,
                oauth: {
                  provider: this.getOAuthProvider(mca),
                  connected: true,
                  email: userAuth.EMAIL,
                  userLogin: userAuth.USER_LOGIN,
                  expiresAt: userAuth.EXPIRY_DATE,
                  extraFields: this.buildExtraFields(mca, userAuth),
                },
                message: "Session expired, reconnect account",
                error: refreshResult.error,
              }
            }
          } else {
            // No refresh token available
            return {
              status: "expired",
              authType,
              oauth: {
                provider: this.getOAuthProvider(mca),
                connected: true,
                email: userAuth.EMAIL,
                userLogin: userAuth.USER_LOGIN,
                expiresAt: userAuth.EXPIRY_DATE,
                extraFields: this.buildExtraFields(mca, userAuth),
              },
              message: "Session expired, reconnect account",
            }
          }
        }
      }

      // 5. All good!
      const ready: AppAuthInfo = {
        status: "ready",
        authType,
        oauth:
          authType === "oauth2" || isGhAppUserOAuth
            ? {
                provider: this.getOAuthProvider(mca),
                connected: true,
                email: userAuth.EMAIL,
                userLogin: userAuth.USER_LOGIN,
                expiresAt: userAuth.EXPIRY_DATE,
                extraFields: this.buildExtraFields(mca, userAuth),
              }
            : undefined,
        apikey:
          authType === "apikey"
            ? {
                configured: true,
                fields: this.buildApiKeyFields(mca, userAuth),
              }
            : undefined,
        githubApp:
          authType === "github-app"
            ? {
                installed: true,
                appSlug: this.resolveAppSlug(mca),
                installationId: userAuth.INSTALLATION_ID,
              }
            : undefined,
      }
      return isGhAppUserOAuth ? this.withGitHubInstallations(ready, userId, appId, mca, userAuth) : ready
    }

    // No user secrets required, just system secrets - ready
    return { status: "ready", authType }
  }

  /**
   * Save API key credentials for an app.
   * Uses merge so that partial updates (e.g., just TEAM_ID) don't wipe existing tokens.
   */
  async saveApiKeyCredentials(
    userId: string,
    appId: string,
    mcaId: string,
    credentials: Record<string, string>,
  ): Promise<void> {
    await this.authManager.merge(userId, appId, mcaId, credentials)
  }

  /**
   * Read a user's stored credentials for an app (decrypted object).
   * Agent secret tools (docs/specs/20261031_agent-secret-tools.md): the
   * get-app-secret backend route uses this to build a MASKED preview —
   * the raw value never leaves the backend.
   */
  async getCredentials(userId: string, appId: string): Promise<Record<string, any> | undefined> {
    return this.authManager.get(userId, appId)
  }

  /**
   * Disconnect OAuth - revoke credentials
   */
  async disconnect(userId: string, appId: string): Promise<void> {
    await this.authManager.revoke(userId, appId)

  }

  /**
   * Refresh an expired OAuth token
   */
  async refreshToken(
    userId: string,
    appId: string,
    mcaId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const key = `${userId}:${appId}`
    const inFlight = this.refreshesInFlight.get(key)
    if (inFlight) return inFlight
    const refresh = this.runRefresh(userId, appId, mcaId).finally(() => this.refreshesInFlight.delete(key))
    this.refreshesInFlight.set(key, refresh)
    return refresh
  }

  private async runRefresh(
    userId: string,
    appId: string,
    mcaId: string,
  ): Promise<{ success: boolean; error?: string }> {
    let usedRefreshToken: string | undefined
    try {
      // 1. Get current credentials
      const currentAuth = await this.authManager.get(userId, appId)
      if (!currentAuth?.REFRESH_TOKEN) {
        return { success: false, error: "No refresh token available" }
      }
      usedRefreshToken = currentAuth.REFRESH_TOKEN

      // 2. Get MCA config
      const mca = await this.catalogCollection.findOne({ mcaId: mcaId })
      if (!mca) {
        return { success: false, error: "MCA not found" }
      }

      const authConfig = mca.auth || (mca.authSchema as any)?.auth
      const secrets = this.secretsManager.mca(mcaId)

      const isGithubAppUserOAuth =
        authConfig?.type === "github-app" && authConfig?.userOAuth === true
      const clientId = isGithubAppUserOAuth
        ? secrets!.GITHUB_APP_CLIENT_ID
        : secrets!.CLIENT_ID
      const clientSecret = isGithubAppUserOAuth
        ? secrets!.GITHUB_APP_CLIENT_SECRET
        : secrets!.CLIENT_SECRET

      // 3. Refresh token — same client-auth method as the initial exchange.
      // Notion/Figma (basicAuth) authenticate at the token endpoint via the
      // `Authorization: Basic` header; everyone else sends client_id in the body.
      // Public PKCE clients (e.g. Plaud) omit client_secret when not configured.
      const provider = authConfig.provider || "custom"
      // PKCE public clients (Plaud) have no client_secret; omit it rather than send empty.
      const effectiveClientSecret = clientSecret || (authConfig.pkce === true ? undefined : clientSecret)
      // Basic Auth: flagged providers (Notion/Figma) AND PKCE CONFIDENTIAL clients
      // (Canva — pkce + a client_secret, TER-464). PKCE PUBLIC clients (Plaud — no
      // secret) authenticate with client_id in the body, NOT Basic.
      const useBasicAuth =
        OAUTH_PROVIDERS[provider]?.basicAuth === true ||
        (authConfig.pkce === true && !!effectiveClientSecret)
      const { headers, body } = buildTokenRequest(
        {
          refresh_token: currentAuth.REFRESH_TOKEN,
          grant_type: "refresh_token",
        },
        { clientId, clientSecret: effectiveClientSecret, useBasicAuth },
      )
      const response = await oauthHttpClient.fetchRaw("POST", authConfig.tokenUrl, body, { headers })

      if (!response.ok) {
        const error = await response.text()
        return this.refreshFailed(userId, appId, usedRefreshToken, `Refresh failed: ${error}`)
      }

      const tokens = (await response.json()) as ProviderTokenResponse
      const tokenError =
        tokenResponseError(tokens) ?? (tokens.access_token ? undefined : "no access_token in response")
      if (tokenError) {
        return this.refreshFailed(userId, appId, usedRefreshToken, `Refresh failed: ${tokenError}`)
      }

      // 4. Update stored credentials
      const expiryDate = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : undefined

      const updated: Record<string, string | undefined> = {
        ACCESS_TOKEN: tokens.access_token,
        REFRESH_TOKEN: tokens.refresh_token || currentAuth.REFRESH_TOKEN,
        EXPIRY_DATE: expiryDate,
      }
      if (isGithubAppUserOAuth) {
        updated.USER_ACCESS_TOKEN = tokens.access_token
        updated.USER_REFRESH_TOKEN = tokens.refresh_token || currentAuth.USER_REFRESH_TOKEN
        updated.USER_TOKEN_EXPIRES_AT = expiryDate
      }
      // Use merge so untouched keys (USER_LOGIN, INSTALLATION_ID, EMAIL) are
      // preserved across refreshes.
      await this.authManager.merge(userId, appId, mcaId, updated)


      return { success: true }
    } catch (error) {
      console.error("[McaOAuth] Refresh token error:", error)
      return this.refreshFailed(
        userId,
        appId,
        usedRefreshToken,
        error instanceof Error ? error.message : "Refresh failed",
      )
    }
  }

  private async refreshFailed(
    userId: string,
    appId: string,
    usedRefreshToken: string | undefined,
    error: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (usedRefreshToken) {
      const latest = await this.authManager.get(userId, appId).catch(() => null)
      if (
        latest?.REFRESH_TOKEN &&
        latest.REFRESH_TOKEN !== usedRefreshToken &&
        (latest.ACCESS_TOKEN || latest.USER_ACCESS_TOKEN)
      ) {
        log.info({ appId }, "Refresh failed but the credentials were already rotated by another caller")
        return { success: true }
      }
    }
    return { success: false, error }
  }

  // =========================================================================
  // Per-user credential helpers (REQ-11 — personal apps)
  // =========================================================================

  // =========================================================================
  // Private helpers
  // =========================================================================

  private determineAuthType(mca: McpCatalogEntry): McaAuthType {
    // Check auth field first (new structure)
    if (mca.auth?.type === "github-app") {
      return "github-app"
    }
    if (mca.auth?.type === "oauth2") {
      return "oauth2"
    }
    if (mca.auth?.type === "agent") {
      return "agent"
    }

    // Fallback to legacy authSchema
    const authConfig = mca.authSchema as any
    if (authConfig?.auth?.type === "oauth2") {
      return "oauth2"
    }

    // Check if there are user secrets defined (implies API key auth)
    const userSecrets = this.getRequiredUserSecrets(mca)
    if (userSecrets.length > 0) {
      return "apikey"
    }

    return "none"
  }

  private getRequiredSystemSecrets(mca: McpCatalogEntry): string[] {
    // Use new systemSecrets field
    return mca.systemSecrets || []
  }

  /**
   * Evaluate system-secret completeness for an MCA (task tn_Qcpm5ajAOTRuuHlE).
   *
   * Default (no systemSecretsAny): ALL declared systemSecrets must be present —
   * unchanged behavior for every existing MCA (gmail, notion, elevenlabs…).
   *
   * With systemSecretsAny (api-key MCAs with alternative credential
   * combinations, e.g. mca.teros.email: Stalwart Lab proxy vs direct admin
   * token): configured = ALL non-grouped systemSecrets present AND at least
   * one complete group. The MCA is operational in ANY of its transport modes
   * — demanding the union of every mode's secrets misreports a working app
   * as needs_system_setup.
   *
   * `missing` (for the needs_system_setup message) lists the non-grouped
   * secrets that are absent plus, when no group is complete, the secrets of
   * the closest incomplete group (fewest missing) — actionable without
   * demanding every alternative at once.
   */
  private evaluateSystemSecrets(
    mca: McpCatalogEntry,
    secrets: Record<string, string | undefined> | undefined,
  ): { configured: boolean; missing: string[] } {
    const declared = this.getRequiredSystemSecrets(mca)
    const groups = mca.systemSecretsAny && mca.systemSecretsAny.length > 0 ? mca.systemSecretsAny : undefined

    // Flat semantics — the historic behavior
    if (!groups) {
      const missing = declared.filter((key) => !secrets?.[key])
      return { configured: missing.length === 0, missing }
    }

    // Group semantics: non-grouped secrets are required unconditionally
    const grouped = new Set(groups.flat())
    const missing = declared.filter((key) => !grouped.has(key) && !secrets?.[key])

    // …and at least one group must be complete
    const groupGaps = groups.map((group) => group.filter((key) => !secrets?.[key]))
    const completeGroupIdx = groupGaps.findIndex((gaps) => gaps.length === 0)
    if (completeGroupIdx !== -1) {
      return { configured: missing.length === 0, missing }
    }

    // No complete group — report the closest one's gaps for the admin message
    const closest = groupGaps.reduce((best, gaps) => (gaps.length < best.length ? gaps : best), groupGaps[0])
    return { configured: false, missing: [...missing, ...closest] }
  }

  private getRequiredUserSecrets(mca: McpCatalogEntry): string[] {
    // Use new userSecrets field
    return mca.userSecrets || []
  }

  private getOAuthProvider(mca: McpCatalogEntry): string {
    // Check auth field first (new structure)
    if (mca.auth?.provider) {
      return mca.auth.provider
    }
    // Detect provider from authorizeUrl
    if (mca.auth?.authorizeUrl?.includes("google")) {
      return "google"
    }
    if (mca.auth?.authorizeUrl?.includes("github")) {
      return "github"
    }
    if (mca.auth?.authorizeUrl?.includes("microsoft")) {
      return "microsoft"
    }
    if (mca.auth?.authorizeUrl?.includes("canva")) {
      return "canva"
    }
    // Fallback to legacy authSchema
    const authConfig = mca.authSchema as any
    return authConfig?.auth?.provider || "custom"
  }

  private async withGitHubInstallations(
    info: AppAuthInfo,
    userId: string,
    appId: string,
    mca: McpCatalogEntry,
    userAuth: Record<string, string | undefined>,
  ): Promise<AppAuthInfo> {
    const token = userAuth.USER_ACCESS_TOKEN
    if (!token || !info.githubApp) return info
    const savedBranches = await this.savedGitHubBranches(appId)
    if (savedBranches.length) info = { ...info, githubApp: { ...info.githubApp, savedBranches } }
    const ghApp = info.githubApp
    if (!ghApp) return info
    const wanted = ((mca.auth as { permissions?: Record<string, string> } | undefined)?.permissions) ?? {}
    const lookup = await cachedGitHubInstallations(`${userId}:${appId}:${token.slice(-12)}`, token, wanted)
    if (lookup.kind === "unauthorized") {
      return {
        status: "expired",
        authType: info.authType,
        oauth: info.oauth ? { ...info.oauth, connected: false } : undefined,
        githubApp: info.githubApp,
        message: "GitHub no longer accepts this connection (it was revoked or has expired). Reconnect GitHub.",
      }
    }
    if (lookup.kind !== "ok") return info
    const installUrl = `https://github.com/apps/${ghApp.appSlug}/installations/select_target`
    const githubApp = {
      ...ghApp,
      installed: lookup.installations.length > 0,
      installUrl,
      installations: lookup.installations,
    }
    if (lookup.installations.length > 0) return { ...info, githubApp }
    return {
      ...info,
      githubApp,
      message:
        "Connected, but the Teros GitHub App is not installed on any account or organization yet, so agents cannot reach any repository. Install it where your repositories live.",
    }
  }

  private async savedGitHubBranches(appId: string): Promise<GitHubSavedBranch[]> {
    try {
      const app = await this.db.collection<App>("apps").findOne({ appId })
      if (!app || app.ownerType !== "workspace") return []
      const ws = await collection(this.db, COLLECTIONS.workspaces).findOne({ workspaceId: app.ownerId })
      const volumeId = (ws as { volumeId?: string } | null)?.volumeId
      if (!volumeId) return []
      const base = process.env.VOLUMES_BASE_PATH || config.volumes.basePath
      const raw = await readFile(join(base, "workspaces", volumeId, ".teros-github", "saved-branches.json"), "utf-8")
      const list = JSON.parse(raw) as GitHubSavedBranch[]
      return Array.isArray(list) ? list.slice(-20) : []
    } catch {
      return []
    }
  }

  private buildNeedsAuthResponse(mca: McpCatalogEntry, authType: McaAuthType): AppAuthInfo {
    if (authType === "github-app") {
      const slug = this.resolveAppSlug(mca)
      return {
        status: "needs_user_auth",
        authType: "github-app",
        githubApp: {
          installed: false,
          appSlug: slug,
        },
        message: "Instala la Teros App en GitHub",
      }
    }

    if (authType === "oauth2") {
      const authConfig = mca.auth || (mca.authSchema as any)?.auth
      return {
        status: "needs_user_auth",
        authType: "oauth2",
        oauth: {
          provider: this.getOAuthProvider(mca),
          connected: false,
          scopes: authConfig?.scopes,
          extraFields: this.buildExtraFields(mca, undefined),
        },
        message: `Conectar cuenta de ${this.formatProviderName(this.getOAuthProvider(mca))}`,
      }
    }

    // API key
    return {
      status: "needs_user_auth",
      authType: "apikey",
      apikey: {
        configured: false,
        fields: this.buildApiKeyFields(mca),
      },
      message: "Configurar credenciales",
    }
  }

  /**
   * Resolve the GitHub App slug for an mca.github-style MCA. Prefers
   * `GITHUB_APP_SLUG` from systemSecrets (env-specific) over the manifest's
   * `appSlug` (default committed to git).
   */
  private resolveAppSlug(mca: McpCatalogEntry): string {
    const secrets = this.secretsManager.mca(mca.mcaId) as { GITHUB_APP_SLUG?: string } | undefined
    if (secrets?.GITHUB_APP_SLUG) return secrets.GITHUB_APP_SLUG
    const auth = mca.auth as { appSlug?: string } | undefined
    return auth?.appSlug ?? "teros"
  }

  /**
   * Campos del formulario de user secrets. `userAuth` (credenciales del user,
   * cuando están a mano) solo alimenta `isSet` — presencia por variable, sin
   * exponer valores — para que la UI (widget in-chat, panel de config) pueda
   * listar las variables del manifest con su estado seteada/vacía.
   */
  private buildApiKeyFields(mca: McpCatalogEntry, userAuth?: Record<string, any>): ApiKeyField[] {
    const userSecrets = this.getRequiredUserSecrets(mca)
    // userSecretsRequired (api-key only): only the mandatory subset is
    // required:true in the form — declared-but-optional overrides (e.g.
    // mca.teros.email MAIL_PASSWORD/MAIL_FROM_NAME) render as optional.
    // Absent = all declared (the historic rule).
    const required = mca.userSecretsRequired && mca.userSecretsRequired.length > 0 ? new Set(mca.userSecretsRequired) : null
    return userSecrets.map((key) => ({
      name: key,
      label: this.formatLabel(key),
      type: this.isSecretField(key) ? "password" : "text",
      required: required ? required.has(key) : true,
      isSet: !!userAuth?.[key],
    }))
  }

  /**
   * Build extraFields for OAuth apps, populating current values from userAuth.
   * Returns undefined if the MCA has no extraFields configured.
   */
  private buildExtraFields(
    mca: McpCatalogEntry,
    userAuth: Record<string, any> | undefined,
  ): ApiKeyField[] | undefined {
    const extraFields = mca.auth?.extraFields
    if (!extraFields || extraFields.length === 0) return undefined

    return extraFields.map((field) => ({
      name: field.name,
      label: field.label || this.formatLabel(field.name),
      type: (field.type as "text" | "password") || "text",
      required: field.required ?? false,
      placeholder: field.placeholder,
      hint: field.hint,
      // Populate current value from stored credentials
      value: userAuth?.[field.name],
    }))
  }

  private formatLabel(key: string): string {
    // APIKEY -> API Key
    // ACCESS_TOKEN -> Access Token
    return key
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ")
  }

  private formatProviderName(provider: string): string {
    const names: Record<string, string> = {
      google: "Google",
      github: "GitHub",
      microsoft: "Microsoft",
      canva: "Canva",
      notion: "Notion",
      figma: "Figma",
      slack: "Slack",
      clickup: "ClickUp",
    }
    return names[provider] || provider
  }

  private isSecretField(key: string): boolean {
    const secretPatterns = ["secret", "password", "token", "key", "apikey"]
    const lowerKey = key.toLowerCase()
    return secretPatterns.some((pattern) => lowerKey.includes(pattern))
  }
}

// Singleton instance
let mcaOAuthInstance: McaOAuth | null = null

export function initMcaOAuth(
  db: Db,
  authManager: AuthManager,
  secretsManager: SecretsManager,
): McaOAuth {
  const catalogCollection = db.collection<McpCatalogEntry>("mca_catalog")
  mcaOAuthInstance = new McaOAuth(db, authManager, secretsManager, catalogCollection)
  return mcaOAuthInstance
}

export function getMcaOAuth(): McaOAuth | null {
  return mcaOAuthInstance
}
