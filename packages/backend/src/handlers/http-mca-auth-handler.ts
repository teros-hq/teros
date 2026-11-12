/**
 * HTTP MCA Auth Handler
 *
 * Handles HTTP endpoints for OAuth authentication of MCAs.
 * Separated from login OAuth because:
 * - Different callbacks (per-app vs global)
 * - Different storage (AuthManager vs SessionManager)
 * - Different redirects (back to app config vs app home)
 *
 * Endpoints:
 * - GET  /auth/mca/:appId/connect    - Start OAuth flow for an app
 * - GET  /auth/mca/callback          - OAuth callback (all providers)
 * - POST /auth/mca/:appId/disconnect - Disconnect OAuth for an app
 *
 * Authentication is ALWAYS required. Every request must carry a valid session
 * via Authorization: Bearer header or teros_session cookie. Unauthenticated
 * requests are rejected with 401 — there is no anonymous fallback.
 */

import type { IncomingMessage, ServerResponse } from "http"
import { config } from '../config';
import { renderOAuthResultPage, scriptJson } from '../lib/oauth-result-page';
import type { AuthService } from "../auth/auth-service"
import type { GitHubAppService } from "../auth/github-app"
import { parseCookies, SESSION_COOKIE_NAME } from "../lib/session-cookie"
import type { McaOAuth } from "../auth/mca-oauth"
import type { SecretsManager } from "../secrets/secrets-manager"
import type { McaService } from "../services/mca-service"
import type { WorkspaceService } from "../services/workspace-service"

export class HttpMcaAuthHandler {
  constructor(
    private mcaOAuth: McaOAuth,
    private mcaService: McaService,
    private authService: AuthService,
    private secretsManager: SecretsManager,
    private workspaceService: WorkspaceService,
    private githubAppService: GitHubAppService,
  ) {}

  /**
   * Handle MCA auth routes
   * Returns true if the route was handled
   */
  async handleRoute(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
    // GET /auth/mca/:appId/connect - Start OAuth flow
    const connectMatch = url.match(/^\/auth\/mca\/([^/]+)\/connect/)
    if (connectMatch && req.method === "GET") {
      await this.handleConnect(req, res, connectMatch[1])
      return true
    }

    // GET /auth/mca/callback - OAuth callback
    if (url.startsWith("/auth/mca/callback")) {
      await this.handleCallback(req, res, url)
      return true
    }

    // POST /auth/mca/:appId/disconnect - Disconnect OAuth
    const disconnectMatch = url.match(/^\/auth\/mca\/([^/]+)\/disconnect/)
    if (disconnectMatch && req.method === "POST") {
      await this.handleDisconnect(req, res, disconnectMatch[1])
      return true
    }

    return false
  }

  /**
   * Handle OAuth connect - redirect to provider
   *
   * Authentication is REQUIRED. userId must be resolved from one of:
   * 1. Header: Authorization: Bearer xxx (primary — frontend uses this)
   * 2. Cookie: teros_session
   *
   * When the client sends `Accept: application/json`, the response is a JSON
   * object `{ url }` so the frontend can open the provider URL directly without
   * ever putting the session token in the URL. Otherwise a 302 redirect is sent
   * for backward compatibility.
   *
   * Access is granted if the user owns the app directly OR is a member
   * of the workspace that owns the app.
   */
  private async handleConnect(
    req: IncomingMessage,
    res: ServerResponse,
    appId: string,
  ): Promise<void> {
    try {
      // Authentication is mandatory — no anonymous fallback
      const userId = await this.getUserIdFromRequest(req)
      if (!userId) {
        this.sendError(res, 401, "Unauthorized - valid session required to start OAuth")
        return
      }

      // Get app info
      const app = await this.mcaService.getApp(appId)
      if (!app) {
        this.sendError(res, 404, "App not found")
        return
      }

      // Verify access: direct ownership, system app, or workspace membership
      const hasAccess =
        app.ownerId === userId ||
        app.ownerId === "system" ||
        (app.ownerType === "workspace" &&
          (await this.workspaceService.canAccess(app.ownerId, userId)))

      if (!hasAccess) {
        this.sendError(res, 403, "Access denied - you do not have access to this app")
        return
      }

      // Get redirect URI for OAuth callback.
      // Some MCAs (e.g. mca.plaud) declare a fixed redirect URI in the manifest
      // because the external SDK requires it. Prefer that value over the generic
      // backend callback path.
      const mca = await this.mcaService.getMcaFromCatalog(app.mcaId)
      const manifestRedirectUri = (mca?.auth as { oauth?: { redirectUri?: string } } | undefined)?.oauth?.redirectUri
      const redirectUri = manifestRedirectUri || this.getOAuthCallbackUri(req)

      // Generate OAuth URL
      const { url } = await this.mcaOAuth.generateAuthUrl(appId, userId, app.mcaId, redirectUri)

      // If the client prefers JSON (fetch-based flow), return the URL as JSON
      // so the frontend can open it without ever putting the token in the URL.
      const acceptJson = (req.headers["accept"] || "").includes("application/json")
      if (acceptJson) {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
        res.end(JSON.stringify({ url }))
      } else {
        // 302 redirect for backward compatibility (e.g. direct browser navigation)
        res.writeHead(302, { Location: url })
        res.end()
      }
    } catch (error) {
      console.error("[HttpMcaAuthHandler] Connect error:", error)
      const message = error instanceof Error ? error.message : "Failed to start OAuth"
      this.redirectWithError(res, message)
    }
  }

  /**
   * Handle OAuth callback from provider
   */
  private async handleCallback(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<void> {
    try {
      const urlObj = new URL(url, `http://${req.headers.host}`)
      const code = urlObj.searchParams.get("code")
      const state = urlObj.searchParams.get("state")
      const error = urlObj.searchParams.get("error")

      // GitHub App: capture installation_id if present
      const installationId = urlObj.searchParams.get("installation_id")
      const setupAction = urlObj.searchParams.get("setup_action") // "install" or "update"
      const realmId = urlObj.searchParams.get("realmId") // QuickBooks (Intuit) company ID

      console.log(`[HttpMcaAuthHandler] OAuth callback received - state: ${state}, code: ${code ? 'present' : 'missing'}, error: ${error || 'none'}, installation_id: ${installationId || 'none'}, setup_action: ${setupAction || 'none'}`)

      // Handle OAuth error from provider
      if (error) {
        console.log(`[HttpMcaAuthHandler] OAuth error from provider: ${error}`)
        this.sendOAuthResult(res, {
          success: false,
          error: `OAuth error: ${error}`,
        })
        return
      }

      // GitHub App installation flow: there is NO `code`, only
      // `installation_id` + `setup_action`. Detect by peeking at the state
      // and dispatching to the GitHub App handler. State is not consumed
      // here — the handler consumes it atomically.
      if (state && installationId && !code) {
        const stateDoc = await this.mcaOAuth.peekState(state)
        if (stateDoc) {
          const mca = await this.mcaService.getMcaFromCatalog(stateDoc.mcaId)
          const authType = (mca?.auth as { type?: string })?.type
          if (authType === "github-app") {
            const result = await this.githubAppService.handleInstallation({
              state,
              installationId,
              setupAction,
            })
            this.sendOAuthResult(res, result)
            return
          }
        }
      }

      if (!state && installationId && setupAction) {
        this.sendOAuthResult(res, { success: true }, {
          title: "GitHub App installed · Teros",
          heading: "Installed",
          lead: "The Teros GitHub App is installed. Back in Teros, your agents can reach the repositories you selected.",
        })
        return
      }

      // Validate parameters
      if (!code || !state) {
        this.sendOAuthResult(res, {
          success: false,
          error: "Missing required parameters",
        })
        return
      }

      // Get redirect URI (must match what was used in generateAuthUrl)
      const redirectUri = this.getOAuthCallbackUri(req)

      // Collect extra params to pass to handleCallback
      const extraParams: Record<string, string> = {}
      if (installationId) extraParams.installation_id = installationId
      if (setupAction) extraParams.setup_action = setupAction
      // @todo nira - 2026.09.20 : if a 3rd OAuth provider needs callback-specific params,
      // refactor this to a per-provider extractCallbackParams hook in OAUTH_PROVIDERS
      // (same pattern as customizeAuthorizeParams / extraCredentials)
      if (realmId) extraParams.realmId = realmId

      // Process callback
      const result = await this.mcaOAuth.handleCallback(code, state, redirectUri, extraParams)

      // Send result
      this.sendOAuthResult(res, result)
    } catch (error) {
      console.error("[HttpMcaAuthHandler] Callback error:", error)
      try {
        this.sendOAuthResult(res, {
          success: false,
          error: error instanceof Error ? error.message : "OAuth callback failed",
        })
      } catch (renderError) {
        console.error("[HttpMcaAuthHandler] Could not render the callback result:", renderError)
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
        res.end("The connection could not be completed. Close this window and try again from Teros.")
      }
    }
  }

  /**
   * Handle OAuth disconnect
   */
  private async handleDisconnect(
    req: IncomingMessage,
    res: ServerResponse,
    appId: string,
  ): Promise<void> {
    try {
      // Authentication is mandatory
      const userId = await this.getUserIdFromRequest(req)
      if (!userId) {
        this.sendJsonError(res, 401, "Unauthorized - valid session required to disconnect OAuth")
        return
      }

      // Get app info
      const app = await this.mcaService.getApp(appId)
      if (!app) {
        this.sendJsonError(res, 404, "App not found")
        return
      }

      // Verify access: direct ownership, system app, or workspace membership
      const hasAccess =
        app.ownerId === userId ||
        app.ownerId === "system" ||
        (app.ownerType === "workspace" &&
          (await this.workspaceService.canAccess(app.ownerId, userId)))

      if (!hasAccess) {
        this.sendJsonError(res, 403, "Access denied - you do not have access to this app")
        return
      }

      // Disconnect
      await this.mcaOAuth.disconnect(userId, appId)

      // Send success
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ success: true }))
    } catch (error) {
      console.error("[HttpMcaAuthHandler] Disconnect error:", error)
      const message = error instanceof Error ? error.message : "Failed to disconnect"
      this.sendJsonError(res, 500, message)
    }
  }

  /**
   * Get userId from request (Authorization header or cookie)
   */
  private async getUserIdFromRequest(req: IncomingMessage): Promise<string | null> {
    // Check Authorization header (primary — frontend uses Bearer tokens)
    const authHeader = req.headers["authorization"]
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7)
      const result = await this.authService.validateSession(token)
      return result.success ? result.user?.userId || null : null
    }

    // Check cookie
    const sessionToken = parseCookies(req)[SESSION_COOKIE_NAME]
    if (sessionToken) {
      const result = await this.authService.validateSession(sessionToken)
      return result.success ? result.user?.userId || null : null
    }

    return null
  }

  /**
   * Get OAuth callback URI
   */
  private getOAuthCallbackUri(req: IncomingMessage): string {
    // Use configured backend URL or construct from request
    const oauthConfig = this.secretsManager.system("oauth")

    if (oauthConfig?.backendUrl) {
      return `${oauthConfig.backendUrl}/auth/mca/callback`
    }

    // Fallback: construct from request headers
    const protocol = req.headers["x-forwarded-proto"] || "http"
    const host = req.headers["x-forwarded-host"] || req.headers.host
    return `${protocol}://${host}/auth/mca/callback`
  }

  /**
   * Get app URL for redirects
   */
  private getAppUrl(): string {
    const appUrl = process.env.APP_URL || this.secretsManager.system("oauth")?.appUrl
    if (!appUrl) {
      throw new Error(
        "appUrl is not configured. Set APP_URL env var or appUrl in .secrets/system/oauth.json.",
      )
    }
    return appUrl
  }

  /**
   * Send OAuth result page (handles popup and redirect flows)
   */
  private sendOAuthResult(
    res: ServerResponse,
    result: { success: boolean; appId?: string; error?: string },
    copy?: { title: string; heading: string; lead: string },
  ): void {
    const appUrl = this.getAppUrl()
    // In dev Metro serves the app at :8081 but APP_URL usually points to the
    // backend or a different port, so postMessage(..., appUrl) gets silenced
    // by the browser for origin mismatch and the popup closes without the
    // client ever hearing about the success (appears as a false "cancelled").
    // Use "*" only in development; in production keep the strict target.
    const postMessageTarget = process.env.NODE_ENV === "production" ? appUrl : "*"

    // Redirect target for the no-popup flow only. The app no longer has a
    // /app/<id> route (static URL rework), so we land on the app root — the
    // user is already authenticated and the app shows the connected state.
    const redirectUrl = result.success
      ? appUrl
      : `${appUrl}?auth=error&message=${encodeURIComponent(result.error || "Unknown error")}`

    const { html, contentSecurityPolicy } = renderOAuthResultPage({
      title: copy?.title ?? (result.success ? "Connected · Teros" : "Connection failed · Teros"),
      success: result.success,
      heading: copy?.heading ?? (result.success ? "Connected" : "Couldn't connect"),
      lead:
        copy?.lead ??
        (result.success
          ? "The app is linked to your account. Back to Teros."
          : "The provider didn't complete the connection. You can try again from Apps."),
      error: result.error,
      returnUrl: appUrl,
      returnLabel: "Back to Teros",
      staticBaseUrl: config.static.baseUrl,
      script: `
    const result = ${scriptJson(result)};
    const postMessageTarget = ${scriptJson(postMessageTarget)};
    // Popup flow: notify the opener; close only on success so an error stays readable.
    if (window.opener) {
      try {
        window.opener.postMessage({
          type: 'mca_oauth_result',
          success: result.success,
          appId: result.appId || '',
          error: result.error || ''
        }, postMessageTarget);
        if (result.success) setTimeout(() => window.close(), 900);
      } catch (e) {
        console.error('Failed to notify opener:', e);
      }
    } else if (result.success) {
      // No popup — full-page redirect flow. Land on the app root.
      setTimeout(() => { window.location.href = ${scriptJson(redirectUrl)}; }, 1500);
    }`,
    })

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": contentSecurityPolicy,
    })
    res.end(html)
  }

  /**
   * Redirect with error message
   */
  private redirectWithError(res: ServerResponse, error: string): void {
    const appUrl = this.getAppUrl()
    const redirectUrl = `${appUrl}?auth=error&message=${encodeURIComponent(error)}`
    res.writeHead(302, { Location: redirectUrl })
    res.end()
  }

  /**
   * Send JSON error response
   */
  private sendJsonError(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ success: false, error: message }))
  }

  /**
   * Send plain error response
   */
  private sendError(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { "Content-Type": "text/plain" })
    res.end(message)
  }
}
