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
 */

import type { IncomingMessage, ServerResponse } from "http"
import type { AuthService } from "../auth/auth-service"
import type { McaOAuth } from "../auth/mca-oauth"
import type { SecretsManager } from "../secrets/secrets-manager"
import type { McaService } from "../services/mca-service"

export class HttpMcaAuthHandler {
  constructor(
    private mcaOAuth: McaOAuth,
    private mcaService: McaService,
    private authService: AuthService,
    private secretsManager: SecretsManager,
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
   * Authentication can come from:
   * 1. Query param: ?token=xxx (for links shared by agent)
   * 2. Cookie: teros_session (for same-domain requests)
   * 3. Header: Authorization: Bearer xxx
   *
   * If no auth provided, we use the app's ownerId as the userId.
   * This is safe because:
   * - The OAuth state will be tied to this userId
   * - The callback will store credentials for this userId
   * - Only the app owner can use those credentials
   */
  private async handleConnect(
    req: IncomingMessage,
    res: ServerResponse,
    appId: string,
  ): Promise<void> {
    try {
      // Get app info first
      const app = await this.mcaService.getApp(appId)
      if (!app) {
        this.sendError(res, 404, "App not found")
        return
      }

      // Try to get userId from request, fall back to app owner
      let userId = await this.getUserIdFromRequest(req)

      if (!userId) {
        // No auth provided - use app owner as userId
        // This is safe because credentials will be stored for the app owner
        userId = app.ownerId
        console.log(`[HttpMcaAuthHandler] No auth provided, using app owner: ${userId}`)
      } else {
        // Auth provided - verify user owns this app or it's a system app
        if (app.ownerId !== userId && app.ownerId !== "system") {
          this.sendError(res, 403, "Access denied - you do not own this app")
          return
        }
      }

      // Get redirect URI for OAuth callback
      const redirectUri = this.getOAuthCallbackUri(req)

      // Generate OAuth URL
      const { url } = await this.mcaOAuth.generateAuthUrl(appId, userId, app.mcaId, redirectUri)

      // Redirect to OAuth provider
      res.writeHead(302, { Location: url })
      res.end()
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

      console.log(`[HttpMcaAuthHandler] OAuth callback received - state: ${state}, code: ${code ? 'present' : 'missing'}, error: ${error || 'none'}`)

      // Handle OAuth error from provider
      if (error) {
        console.log(`[HttpMcaAuthHandler] OAuth error from provider: ${error}`)
        this.sendOAuthResult(res, {
          success: false,
          error: `OAuth error: ${error}`,
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

      // Process callback
      const result = await this.mcaOAuth.handleCallback(code, state, redirectUri)

      // Send result
      this.sendOAuthResult(res, result)
    } catch (error) {
      console.error("[HttpMcaAuthHandler] Callback error:", error)
      this.sendOAuthResult(res, {
        success: false,
        error: error instanceof Error ? error.message : "OAuth callback failed",
      })
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
      // Get userId from session token
      const userId = await this.getUserIdFromRequest(req)
      if (!userId) {
        this.sendJsonError(res, 401, "Not authenticated")
        return
      }

      // Get app info
      const app = await this.mcaService.getApp(appId)
      if (!app) {
        this.sendJsonError(res, 404, "App not found")
        return
      }

      // Verify user owns this app or it's a system app
      if (app.ownerId !== userId && app.ownerId !== "system") {
        this.sendJsonError(res, 403, "Access denied")
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
   * Get userId from request (Authorization header, cookie, or query param)
   */
  private async getUserIdFromRequest(req: IncomingMessage): Promise<string | null> {
    // Check Authorization header
    const authHeader = req.headers["authorization"]
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7)
      const result = await this.authService.validateSession(token)
      return result.success ? result.user?.userId || null : null
    }

    // Check query parameter (for popup OAuth flow)
    const url = new URL(req.url || "", `http://${req.headers.host}`)
    const queryToken = url.searchParams.get("token")
    if (queryToken) {
      const result = await this.authService.validateSession(queryToken)
      return result.success ? result.user?.userId || null : null
    }

    // Check cookie
    const cookies = this.parseCookies(req)
    const sessionToken = cookies["teros_session"]
    if (sessionToken) {
      const result = await this.authService.validateSession(sessionToken)
      return result.success ? result.user?.userId || null : null
    }

    return null
  }

  /**
   * Parse cookies from request
   */
  private parseCookies(req: IncomingMessage): Record<string, string> {
    const cookies: Record<string, string> = {}
    const cookieHeader = req.headers.cookie

    if (cookieHeader) {
      cookieHeader.split(";").forEach((cookie) => {
        const [name, ...rest] = cookie.trim().split("=")
        cookies[name] = rest.join("=")
      })
    }

    return cookies
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
  ): void {
    const appUrl = this.getAppUrl()

    // Build redirect URL
    const redirectUrl = result.success
      ? `${appUrl}/app/${result.appId}?auth=success`
      : `${appUrl}/apps?auth=error&message=${encodeURIComponent(result.error || "Unknown error")}`

    // HTML page that handles both popup and redirect flows
    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Conectando...</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: #09090B;
      color: #FAFAFA;
    }
    .container {
      text-align: center;
      padding: 40px;
    }
    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid #27272A;
      border-top-color: #3B82F6;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 20px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .success { color: #10B981; }
    .error { color: #EF4444; }
    a { color: #3B82F6; }
  </style>
</head>
<body>
  <div class="container">
    ${
      result.success
        ? `
      <div class="spinner"></div>
      <h2 class="success">Connected successfully</h2>
      <p>Redirecting...</p>
    `
        : `
      <h2 class="error">Connection error</h2>
      <p>${result.error || "Unknown error"}</p>
      <p><a href="${appUrl}/apps">Back to Apps</a></p>
    `
    }
  </div>
  <script>
    const result = ${JSON.stringify(result)};
    const appUrl = '${appUrl}';
    
    // Try to notify opener (popup flow)
    if (window.opener) {
      try {
        window.opener.postMessage({
          type: 'mca_oauth_result',
          success: result.success,
          appId: result.appId || '',
          error: result.error || ''
        }, appUrl);
        
        // Close popup after short delay (only on success — on error keep it open so user can read)
        if (result.success) {
          setTimeout(() => window.close(), 1000);
        }
      } catch (e) {
        console.error('Failed to notify opener:', e);
      }
    }
    
    // Redirect after delay (redirect flow or popup fallback)
    if (result.success) {
      setTimeout(() => {
        window.location.href = '${redirectUrl}';
      }, 1500);
    }
  </script>
</body>
</html>`.trim()

    res.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-store",
    })
    res.end(html)
  }

  /**
   * Redirect with error message
   */
  private redirectWithError(res: ServerResponse, error: string): void {
    const appUrl = this.getAppUrl()
    const redirectUrl = `${appUrl}/apps?auth=error&message=${encodeURIComponent(error)}`
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
