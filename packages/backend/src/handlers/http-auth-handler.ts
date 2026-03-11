/**
 * HTTP Auth Handler
 *
 * Handles HTTP endpoints for OAuth callbacks.
 * OAuth requires HTTP redirects which can't be done over WebSocket.
 */

import type { IncomingMessage, ServerResponse } from "http"
import { captureException } from "../lib/sentry"
import type { SecretsManager } from "../secrets/secrets-manager"
import type { SessionManager } from "../services/session-manager"
import { AuthHandler } from "./auth-handler"

export class HttpAuthHandler {
  private authHandler: AuthHandler
  private secretsManager?: SecretsManager

  constructor(sessionManager: SessionManager, secretsManager?: SecretsManager) {
    this.authHandler = new AuthHandler(sessionManager)
    this.secretsManager = secretsManager
  }

  /**
   * Handle OAuth callback routes
   * Returns true if the route was handled
   */
  async handleRoute(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
    // Google OAuth connect - start OAuth flow (popup pattern, same as MCA OAuth)
    if (url.startsWith("/auth/google/connect")) {
      await this.handleGoogleConnect(req, res)
      return true
    }

    // Google OAuth init - returns auth URL (legacy REST endpoint)
    if (url.startsWith("/api/auth/google/init")) {
      await this.handleGoogleInit(req, res)
      return true
    }

    // Google OAuth callback
    if (url.startsWith("/auth/google/callback")) {
      await this.handleGoogleCallback(req, res, url)
      return true
    }

    return false
  }

  /**
   * Handle Google OAuth connect - redirect to Google
   * GET /auth/google/connect
   *
   * This follows the same pattern as MCA OAuth:
   * 1. Frontend opens popup to this URL
   * 2. We redirect to Google OAuth
   * 3. Google redirects back to /auth/google/callback
   * 4. Callback sends postMessage to opener and closes popup
   */
  private async handleGoogleConnect(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const result = await this.authHandler.initGoogleOAuth()

      if (!result.success || !result.url) {
        this.sendOAuthResult(res, {
          success: false,
          error: result.error || "Google authentication not configured",
        })
        return
      }

      // Redirect to Google OAuth
      res.writeHead(302, { Location: result.url })
      res.end()
    } catch (error) {
      console.error("[HttpAuthHandler] Google connect error:", error)
      captureException(error, { context: "http-auth-google-connect" })
      this.sendOAuthResult(res, {
        success: false,
        error: "Failed to start Google authentication",
      })
    }
  }

  /**
   * Handle Google OAuth initialization
   * POST /api/auth/google/init
   * Returns the Google OAuth URL to redirect the user to
   */
  private async handleGoogleInit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS headers are set in index.ts - don't duplicate them

    try {
      const result = await this.authHandler.initGoogleOAuth()

      if (!result.success) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            error: result.error || "Failed to initialize Google OAuth",
          }),
        )
        return
      }

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          url: result.url,
          state: result.state,
        }),
      )
    } catch (error) {
      console.error("[HttpAuthHandler] Google init error:", error)
      captureException(error, { context: "http-auth-google-init" })
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Internal server error" }))
    }
  }

  /**
   * Handle Google OAuth callback
   *
   * After user authorizes in Google, they're redirected here with:
   * - code: Authorization code to exchange for tokens
   * - state: CSRF protection token
   */
  private async handleGoogleCallback(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<void> {
    try {
      // Parse query parameters
      const urlObj = new URL(url, `http://${req.headers.host}`)
      const code = urlObj.searchParams.get("code")
      const state = urlObj.searchParams.get("state")
      const error = urlObj.searchParams.get("error")

      // Handle OAuth errors (user denied, etc.)
      if (error) {
        console.log(`[HttpAuthHandler] Google OAuth error: ${error}`)
        this.sendOAuthResult(res, {
          success: false,
          error: `Google authentication failed: ${error}`,
        })
        return
      }

      // Validate required parameters
      if (!code || !state) {
        this.sendOAuthResult(res, {
          success: false,
          error: "Missing required parameters",
        })
        return
      }

      // Get client metadata
      const metadata = {
        userAgent: req.headers["user-agent"],
        ipAddress: this.getClientIP(req),
      }

      // Process OAuth callback
      const result = await this.authHandler.handleGoogleCallback(code, state, metadata)

      if (!result.success) {
        this.sendOAuthResult(res, {
          success: false,
          error: result.error || "Authentication failed",
        })
        return
      }

      // Success! Send result to client
      this.sendOAuthResult(res, {
        success: true,
        token: result.sessionToken!,
        userId: result.userId!,
        user: result.user!,
      })
    } catch (error) {
      console.error("[HttpAuthHandler] Google callback error:", error)
      captureException(error, { context: "http-auth-google-callback" })
      this.sendOAuthResult(res, {
        success: false,
        error: "Internal server error",
      })
    }
  }

  /**
   * Send OAuth result to client
   *
   * Uses a small HTML page that:
   * 1. Stores the token in localStorage
   * 2. Sends result to opener window via postMessage (for popup flow)
   * 3. Redirects to app (for redirect flow)
   */
  private sendOAuthResult(
    res: ServerResponse,
    result: {
      success: boolean
      token?: string
      userId?: string
      user?: any
      error?: string
    },
  ): void {
    // Get appUrl from env or secrets — required, no fallback
    const appUrl = process.env.APP_URL || this.secretsManager?.system("oauth")?.appUrl
    if (!appUrl) {
      throw new Error(
        "appUrl is not configured. Set APP_URL env var or appUrl in .secrets/system/oauth.json.",
      )
    }

    // HTML that handles both popup and redirect flows
    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Authentication</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: #f5f5f5;
    }
    .container {
      text-align: center;
      padding: 40px;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    .success { color: #22c55e; }
    .error { color: #ef4444; }
    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid #e5e5e5;
      border-top-color: #3b82f6;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 20px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="container">
    ${
      result.success
        ? `
      <div class="spinner"></div>
      <h2 class="success">Authentication successful!</h2>
      <p>Redirecting...</p>
    `
        : `
      <h2 class="error">Authentication failed</h2>
      <p>${result.error || "Unknown error"}</p>
      <p><a href="${appUrl}">Return to app</a></p>
    `
    }
  </div>
  <script>
    const result = ${JSON.stringify(result)};
    
    // Store token if successful
    if (result.success && result.token) {
      try {
        localStorage.setItem('teros_session_token', result.token);
        localStorage.setItem('teros_user', JSON.stringify(result.user));
      } catch (e) {
        console.error('Failed to store token:', e);
      }
    }
    
    // Try to send to opener (popup flow)
    if (window.opener) {
      try {
        window.opener.postMessage({
          type: 'oauth_result',
          ...result
        }, '${appUrl}');
        
        // Close popup after a short delay
        setTimeout(() => window.close(), 1000);
      } catch (e) {
        console.error('Failed to send to opener:', e);
      }
    }
    
    // Redirect to app (redirect flow or if popup messaging fails)
    if (result.success) {
      setTimeout(() => {
        window.location.href = '${appUrl}';
      }, 1500);
    }
  </script>
</body>
</html>
    `.trim()

    res.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-store",
    })
    res.end(html)
  }

  /**
   * Get client IP address from request
   */
  private getClientIP(req: IncomingMessage): string | undefined {
    // Check X-Forwarded-For header (for proxies)
    const forwarded = req.headers["x-forwarded-for"]
    if (forwarded) {
      const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded
      return ips.split(",")[0].trim()
    }

    // Check X-Real-IP header
    const realIP = req.headers["x-real-ip"]
    if (realIP) {
      return Array.isArray(realIP) ? realIP[0] : realIP
    }

    // Fall back to socket address
    return req.socket.remoteAddress
  }
}
