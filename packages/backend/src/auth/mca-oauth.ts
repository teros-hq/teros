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
  McaAuthType,
  McaOAuthState,
  OAuthTokenResponse,
} from "@teros/core"
import { createHash, randomBytes } from "crypto"
import { type Collection, type Db, ObjectId } from "mongodb"
import type { SecretsManager } from "../secrets/secrets-manager"
import type { McpCatalogEntry } from "../types/database"
import type { AuthManager } from "./auth-manager"

// Known OAuth provider configurations
const OAUTH_PROVIDERS: Record<
  string,
  {
    userInfoUrl: string
    userInfoFields: { email: string; name?: string }
    userInfoHeaders?: Record<string, string>
    emailFallbackFields?: string[]
    basicAuth?: boolean // Use Basic Auth for token endpoint instead of body params
  }
> = {
  google: {
    userInfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    userInfoFields: { email: "email", name: "name" },
  },
  github: {
    userInfoUrl: "https://api.github.com/user",
    userInfoFields: { email: "email", name: "name" },
  },
  microsoft: {
    userInfoUrl: "https://graph.microsoft.com/v1.0/me",
    userInfoFields: { email: "mail", name: "displayName" },
    emailFallbackFields: ["userPrincipalName"],
  },
  canva: {
    userInfoUrl: "https://api.canva.com/rest/v1/users/me/profile",
    userInfoFields: { email: "display_name", name: "display_name" }, // Canva doesn't expose email, use display_name
  },
  clickup: {
    userInfoUrl: "https://api.clickup.com/api/v2/user",
    userInfoFields: { email: "email", name: "username" },
  },
  notion: {
    userInfoUrl: "https://api.notion.com/v1/users/me",
    userInfoFields: { email: "email", name: "name" },
    userInfoHeaders: { "Notion-Version": "2022-06-28" },
    basicAuth: true, // Notion requires Basic Auth for token exchange
  },
}

// State token expiration (10 minutes)
const STATE_EXPIRATION_MS = 10 * 60 * 1000

/**
 * MongoDB document for MCA OAuth state
 */
interface McaOAuthStateDocument {
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

export class McaOAuth {
  private statesCollection: Collection<McaOAuthStateDocument>
  private connectionManager?: {
    sendCredentialsUpdate: (appId: string, credentials: Record<string, string>) => boolean
  }

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

  /**
   * Initialize indexes for the states collection
   */
  async ensureIndexes(): Promise<void> {
    // Unique state token
    await this.statesCollection.createIndex({ state: 1 }, { unique: true })
    // TTL: auto-delete expired states
    await this.statesCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
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

    // 2. Validate MCA has OAuth config
    const authConfig = mca.auth || (mca.authSchema as any)?.auth
    if (!authConfig || authConfig.type !== "oauth2") {
      throw new Error(`MCA ${mcaId} does not support OAuth`)
    }

    // 3. Load client credentials from secrets
    const secrets = this.secretsManager.mca(mcaId)
    if (!secrets?.CLIENT_ID || !secrets?.CLIENT_SECRET) {
      throw new Error(`OAuth client credentials not configured for ${mcaId}`)
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
    const params = new URLSearchParams({
      client_id: secrets.CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: (authConfig.scopes || []).join(" "),
      state,
    })

    // Add PKCE parameters if enabled
    if (codeChallenge) {
      params.append("code_challenge", codeChallenge)
      params.append("code_challenge_method", "S256")
    } else {
      // Only add these for non-PKCE flows (Google-style)
      params.append("access_type", "offline") // Request refresh token
      params.append("prompt", "consent") // Always show consent (ensures refresh token)
    }

    const url = `${authConfig.authorizeUrl}?${params.toString()}`

    return { url, state }
  }

  /**
   * Handle OAuth callback - exchange code for tokens
   */
  async handleCallback(
    code: string,
    state: string,
    redirectUri: string,
  ): Promise<{ success: boolean; appId?: string; error?: string }> {
    // 1. Validate state
    const stateDoc = await this.statesCollection.findOneAndDelete({
      state,
      expiresAt: { $gt: new Date() },
    })

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

      // 3. Exchange code for tokens
      const providerBasicAuth = OAUTH_PROVIDERS[stateDoc.provider]?.basicAuth === true
      const tokens = await this.exchangeCode(code, {
        tokenUrl: authConfig.tokenUrl,
        clientId: secrets!.CLIENT_ID,
        clientSecret: secrets!.CLIENT_SECRET,
        redirectUri,
        codeVerifier: stateDoc.codeVerifier, // For PKCE flow
        usePkce: authConfig.pkce === true,
        useBasicAuth: providerBasicAuth,
      })

      // 4. Get user info (for known providers)
      let email: string | undefined
      const providerConfig = OAUTH_PROVIDERS[stateDoc.provider]
      if (providerConfig) {
        try {
          const userInfo = await this.getUserInfo(providerConfig.userInfoUrl, tokens.access_token, providerConfig.userInfoHeaders)
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
      const credentials = {
        ACCESS_TOKEN: tokens.access_token,
        REFRESH_TOKEN: tokens.refresh_token,
        EXPIRY_DATE: expiryDate,
        EMAIL: email,
      }

      await this.authManager.set(stateDoc.userId, stateDoc.appId, stateDoc.mcaId, credentials)

      // 7. Notify MCA via WebSocket if connected
      if (this.connectionManager) {
        const sent = this.connectionManager.sendCredentialsUpdate(
          stateDoc.appId,
          credentials as Record<string, string>,
        )
        if (sent) {
          console.log(`[McaOAuth] Notified MCA ${stateDoc.appId} of new credentials`)
        } else {
          console.log(
            `[McaOAuth] MCA ${stateDoc.appId} not connected, credentials will be loaded on next spawn`,
          )
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
      clientSecret: string
      redirectUri: string
      codeVerifier?: string
      usePkce?: boolean
      useBasicAuth?: boolean
    },
  ): Promise<OAuthTokenResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    }

    // Build request body
    const bodyParams: Record<string, string> = {
      code,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
    }

    if ((config.usePkce && config.codeVerifier) || config.useBasicAuth) {
      // PKCE flow or providers requiring Basic Auth (e.g. Notion): use Basic Auth header
      const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString(
        "base64",
      )
      headers["Authorization"] = `Basic ${credentials}`
      if (config.codeVerifier) {
        bodyParams.code_verifier = config.codeVerifier
      }
    } else {
      // Standard flow: client credentials in body
      bodyParams.client_id = config.clientId
      bodyParams.client_secret = config.clientSecret
    }

    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers,
      body: new URLSearchParams(bodyParams),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Token exchange failed: ${error}`)
    }

    return response.json() as Promise<OAuthTokenResponse>
  }

  /**
   * Get user info from OAuth provider
   */
  private async getUserInfo(url: string, accessToken: string, extraHeaders?: Record<string, string>): Promise<Record<string, any>> {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...extraHeaders,
      },
    })

    if (!response.ok) {
      throw new Error(`Failed to get user info: ${response.status}`)
    }

    return response.json() as Promise<Record<string, any>>
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

    // 2. Check system secrets (required for OAuth client credentials or shared API keys)
    const systemSecrets = this.getRequiredSystemSecrets(mca)
    if (systemSecrets.length > 0) {
      const secrets = this.secretsManager.mca(mca.mcaId)
      const missingSecrets = systemSecrets.filter((key) => !secrets?.[key])

      if (missingSecrets.length > 0) {
        return {
          status: "needs_system_setup",
          authType,
          message: `Requiere configuracion de admin: ${missingSecrets.join(", ")}`,
        }
      }
    }

    // 3. Check user credentials
    const userSecrets = this.getRequiredUserSecrets(mca)
    if (userSecrets.length > 0) {
      const userAuth = await this.authManager.get(userId, appId)

      if (!userAuth) {
        return this.buildNeedsAuthResponse(mca, authType)
      }

      // 4. Check token expiry for OAuth and auto-refresh if needed
      if (authType === "oauth2" && userAuth.EXPIRY_DATE) {
        const expiry = new Date(userAuth.EXPIRY_DATE)
        const now = new Date()
        // Add 5 minute buffer - refresh if expiring soon
        const expiryBuffer = new Date(now.getTime() + 5 * 60 * 1000)

        if (expiry < expiryBuffer) {
          // Token expired or expiring soon - try to refresh
          if (userAuth.REFRESH_TOKEN) {
            console.log(`[McaOAuth] Token expired/expiring for ${appId}, attempting refresh...`)
            const refreshResult = await this.refreshToken(userId, appId, mca.mcaId)

            if (refreshResult.success) {
              console.log(`[McaOAuth] Token refreshed successfully for ${appId}`)
              // Get updated credentials after refresh
              const updatedAuth = await this.authManager.get(userId, appId)
              return {
                status: "ready",
                authType: "oauth2",
                oauth: {
                  provider: this.getOAuthProvider(mca),
                  connected: true,
                  email: updatedAuth?.EMAIL,
                  expiresAt: updatedAuth?.EXPIRY_DATE,
                },
              }
            } else {
              console.warn(`[McaOAuth] Token refresh failed for ${appId}: ${refreshResult.error}`)
              // Refresh failed - token is truly expired
              return {
                status: "expired",
                authType: "oauth2",
                oauth: {
                  provider: this.getOAuthProvider(mca),
                  connected: true,
                  email: userAuth.EMAIL,
                  expiresAt: userAuth.EXPIRY_DATE,
                },
                message: "Session expired, reconnect account",
                error: refreshResult.error,
              }
            }
          } else {
            // No refresh token available
            return {
              status: "expired",
              authType: "oauth2",
              oauth: {
                provider: this.getOAuthProvider(mca),
                connected: true,
                email: userAuth.EMAIL,
                expiresAt: userAuth.EXPIRY_DATE,
              },
              message: "Session expired, reconnect account",
            }
          }
        }
      }

      // 5. All good!
      return {
        status: "ready",
        authType,
        oauth:
          authType === "oauth2"
            ? {
                provider: this.getOAuthProvider(mca),
                connected: true,
                email: userAuth.EMAIL,
                expiresAt: userAuth.EXPIRY_DATE,
              }
            : undefined,
        apikey:
          authType === "apikey"
            ? {
                configured: true,
                fields: this.buildApiKeyFields(mca),
              }
            : undefined,
      }
    }

    // No user secrets required, just system secrets - ready
    return { status: "ready", authType }
  }

  /**
   * Save API key credentials for an app
   */
  async saveApiKeyCredentials(
    userId: string,
    appId: string,
    mcaId: string,
    credentials: Record<string, string>,
  ): Promise<void> {
    await this.authManager.set(userId, appId, mcaId, credentials)
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
    try {
      // 1. Get current credentials
      const currentAuth = await this.authManager.get(userId, appId)
      if (!currentAuth?.REFRESH_TOKEN) {
        return { success: false, error: "No refresh token available" }
      }

      // 2. Get MCA config
      const mca = await this.catalogCollection.findOne({ mcaId: mcaId })
      if (!mca) {
        return { success: false, error: "MCA not found" }
      }

      const authConfig = mca.auth || (mca.authSchema as any)?.auth
      const secrets = this.secretsManager.mca(mcaId)

      // 3. Refresh token
      const response = await fetch(authConfig.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          client_id: secrets!.CLIENT_ID,
          client_secret: secrets!.CLIENT_SECRET,
          refresh_token: currentAuth.REFRESH_TOKEN,
          grant_type: "refresh_token",
        }),
      })

      if (!response.ok) {
        const error = await response.text()
        return { success: false, error: `Refresh failed: ${error}` }
      }

      const tokens = (await response.json()) as OAuthTokenResponse

      // 4. Update stored credentials
      const expiryDate = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : undefined

      await this.authManager.set(userId, appId, mcaId, {
        ACCESS_TOKEN: tokens.access_token,
        REFRESH_TOKEN: tokens.refresh_token || currentAuth.REFRESH_TOKEN,
        EXPIRY_DATE: expiryDate,
        EMAIL: currentAuth.EMAIL,
      })

      return { success: true }
    } catch (error) {
      console.error("[McaOAuth] Refresh token error:", error)
      return {
        success: false,
        error: error instanceof Error ? error.message : "Refresh failed",
      }
    }
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private determineAuthType(mca: McpCatalogEntry): McaAuthType {
    // Check auth field first (new structure)
    if (mca.auth?.type === "oauth2") {
      return "oauth2"
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

  private buildNeedsAuthResponse(mca: McpCatalogEntry, authType: McaAuthType): AppAuthInfo {
    if (authType === "oauth2") {
      const authConfig = mca.auth || (mca.authSchema as any)?.auth
      return {
        status: "needs_user_auth",
        authType: "oauth2",
        oauth: {
          provider: this.getOAuthProvider(mca),
          connected: false,
          scopes: authConfig?.scopes,
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

  private buildApiKeyFields(mca: McpCatalogEntry): ApiKeyField[] {
    const userSecrets = this.getRequiredUserSecrets(mca)
    return userSecrets.map((key) => ({
      name: key,
      label: this.formatLabel(key),
      type: this.isSecretField(key) ? "password" : "text",
      required: true,
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
