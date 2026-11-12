/**
 * HTTP Auth Handler
 *
 * Handles HTTP endpoints for OAuth callbacks.
 * OAuth requires HTTP redirects which can't be done over WebSocket.
 */

import type { IncomingMessage, ServerResponse } from "http"
import { config } from "../config"
import { renderOAuthResultPage, scriptJson } from "../lib/oauth-result-page"
import type { AuthMessage } from "@teros/shared"
import { captureException } from "../lib/sentry"
import {
  buildSessionCookie,
  buildSessionCookieClear,
  parseCookies,
  SESSION_COOKIE_NAME,
} from "../lib/session-cookie"
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

    // Microsoft OAuth connect - start OAuth flow (popup pattern, same as Google)
    if (url.startsWith("/auth/microsoft/connect")) {
      await this.handleMicrosoftConnect(req, res)
      return true
    }

    // Microsoft OAuth init - returns auth URL (legacy REST endpoint)
    if (url.startsWith("/api/auth/microsoft/init")) {
      await this.handleMicrosoftInit(req, res)
      return true
    }

    // Microsoft OAuth callback
    if (url.startsWith("/auth/microsoft/callback")) {
      await this.handleMicrosoftCallback(req, res, url)
      return true
    }

    // GitHub OAuth connect - start OAuth flow (popup pattern, same as Google/Microsoft)
    if (url.startsWith("/auth/github/connect")) {
      await this.handleGitHubConnect(req, res)
      return true
    }

    // GitHub OAuth init - returns auth URL (legacy REST endpoint)
    if (url.startsWith("/api/auth/github/init")) {
      await this.handleGitHubInit(req, res)
      return true
    }

    // GitHub OAuth callback
    if (url.startsWith("/auth/github/callback")) {
      await this.handleGitHubCallback(req, res, url)
      return true
    }

    // Session cookie endpoints — web session persistence (Req 6.6.1)
    if (url === "/auth/session" || url.startsWith("/auth/session?")) {
      await this.handleSession(req, res)
      return true
    }

    return false
  }

  /**
   * Session cookie endpoints (Req 6.6.1)
   *
   * On web the session token lives in-memory only (never in localStorage), so
   * an httpOnly cookie on the backend origin is what makes the session survive
   * page reloads:
   * - GET    /auth/session — validate the cookie and return the session STATE
   *          (userId, user, expiresAt, impersonation) — never the token (F2).
   *          Re-issues the cookie (sliding expiration). The web client then
   *          authenticates its WebSocket with the cookie (auth method
   *          "cookie"), and HTTP calls send the cookie with
   *          credentials: 'include'.
   * - POST   /auth/session — install the cookie for the Bearer token in the
   *          Authorization header (called after email/password login; the
   *          Google OAuth callback sets the cookie itself).
   * - DELETE /auth/session — revoke the session (best-effort) and clear the
   *          cookie (logout).
   *
   * CSRF: POST is authenticated by the Bearer header (not the cookie), and
   * DELETE only clears/revokes; SameSite=Lax keeps the cookie off cross-site
   * subresource requests.
   */
  private async handleSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method || "GET").toUpperCase()

    try {
      if (method === "GET") {
        const token = parseCookies(req)[SESSION_COOKIE_NAME]
        if (!token) {
          this.sendSessionJson(res, 401, { success: false, error: "No session cookie" })
          return
        }
        const result = await this.authHandler.authenticate({
          type: "auth",
          method: "token",
          sessionToken: token,
        } as AuthMessage)
        if (!result.success) {
          // Invalid/expired token: clear the cookie so the client stops retrying it
          res.setHeader("Set-Cookie", buildSessionCookieClear(req))
          this.sendSessionJson(res, 401, { success: false, error: "Invalid or expired session" })
          return
        }
        // Re-issue the cookie so active users get a sliding expiration
        res.setHeader("Set-Cookie", buildSessionCookie(token, req))
        // F2: the response body carries the session STATE only. The token
        // itself must never appear here — the cookie is httpOnly precisely so
        // JS can't read it, and any same-origin script (shared HTML via
        // /objects, XSS) could otherwise fetch this endpoint and steal the
        // 30-day session. The web client authenticates the WS with the
        // cookie (auth method "cookie") instead of a token.
        this.sendSessionJson(res, 200, {
          success: true,
          userId: result.userId,
          user: result.user,
          expiresAt: result.sessionExpiresAt,
          ...(result.impersonation ? { impersonation: result.impersonation } : {}),
        })
        return
      }

      if (method === "POST") {
        const authHeader = req.headers["authorization"]
        const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null
        if (!token) {
          this.sendSessionJson(res, 401, { success: false, error: "Missing Bearer token" })
          return
        }
        const result = await this.authHandler.authenticate({
          type: "auth",
          method: "token",
          sessionToken: token,
        } as AuthMessage)
        if (!result.success) {
          this.sendSessionJson(res, 401, { success: false, error: "Invalid or expired session" })
          return
        }
        res.setHeader("Set-Cookie", buildSessionCookie(token, req))
        res.writeHead(204)
        res.end()
        return
      }

      if (method === "DELETE") {
        const token = parseCookies(req)[SESSION_COOKIE_NAME]
        if (token) {
          // Best-effort server-side revocation (also writes the logout audit log)
          await this.authHandler.logout(token).catch(() => false)
        }
        res.setHeader("Set-Cookie", buildSessionCookieClear(req))
        res.writeHead(204)
        res.end()
        return
      }

      res.writeHead(405, { Allow: "GET, POST, DELETE" })
      res.end()
    } catch (error) {
      console.error("[HttpAuthHandler] Session endpoint error:", error)
      captureException(error, { context: "http-auth-session" })
      this.sendSessionJson(res, 500, { success: false, error: "Internal server error" })
    }
  }

  private sendSessionJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    })
    res.end(JSON.stringify(body))
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

      // Success! Install the httpOnly session cookie (web session persistence,
      // Req 6.6.1) and send the result to the client. The cookie is scoped to
      // the backend origin, so setting it from the popup covers the whole app.
      res.setHeader("Set-Cookie", buildSessionCookie(result.sessionToken!, req))
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
   * Handle Microsoft OAuth connect - redirect to Microsoft
   * GET /auth/microsoft/connect
   *
   * Same popup pattern as Google:
   * 1. Frontend opens popup to this URL
   * 2. We redirect to Microsoft OAuth consent
   * 3. Microsoft redirects back to /auth/microsoft/callback
   * 4. Callback sends postMessage to opener and closes popup
   */
  private async handleMicrosoftConnect(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const result = await this.authHandler.initMicrosoftOAuth()

      if (!result.success || !result.url) {
        this.sendOAuthResult(res, {
          success: false,
          error: result.error || "Microsoft authentication not configured",
        })
        return
      }

      // Redirect to Microsoft OAuth
      res.writeHead(302, { Location: result.url })
      res.end()
    } catch (error) {
      console.error("[HttpAuthHandler] Microsoft connect error:", error)
      captureException(error, { context: "http-auth-microsoft-connect" })
      this.sendOAuthResult(res, {
        success: false,
        error: "Failed to start Microsoft authentication",
      })
    }
  }

  /**
   * Handle Microsoft OAuth initialization
   * POST /api/auth/microsoft/init
   * Returns the Microsoft OAuth URL to redirect the user to
   */
  private async handleMicrosoftInit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const result = await this.authHandler.initMicrosoftOAuth()

      if (!result.success) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            error: result.error || "Failed to initialize Microsoft OAuth",
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
      console.error("[HttpAuthHandler] Microsoft init error:", error)
      captureException(error, { context: "http-auth-microsoft-init" })
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Internal server error" }))
    }
  }

  /**
   * Handle Microsoft OAuth callback
   *
   * After user authorizes in Microsoft, they're redirected here with:
   * - code: Authorization code to exchange for tokens
   * - state: CSRF protection token
   */
  private async handleMicrosoftCallback(
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
        console.log(`[HttpAuthHandler] Microsoft OAuth error: ${error}`)
        this.sendOAuthResult(res, {
          success: false,
          error: `Microsoft authentication failed: ${error}`,
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
      const result = await this.authHandler.handleMicrosoftCallback(code, state, metadata)

      if (!result.success) {
        this.sendOAuthResult(res, {
          success: false,
          error: result.error || "Authentication failed",
        })
        return
      }

      // Success! Install the httpOnly session cookie (same as Google flow)
      res.setHeader("Set-Cookie", buildSessionCookie(result.sessionToken!, req))
      this.sendOAuthResult(res, {
        success: true,
        token: result.sessionToken!,
        userId: result.userId!,
        user: result.user!,
      })
    } catch (error) {
      console.error("[HttpAuthHandler] Microsoft callback error:", error)
      captureException(error, { context: "http-auth-microsoft-callback" })
      this.sendOAuthResult(res, {
        success: false,
        error: "Internal server error",
      })
    }
  }

  /**
   * Handle GitHub OAuth connect - redirect to GitHub
   * GET /auth/github/connect
   *
   * Same popup pattern as Google/Microsoft:
   * 1. Frontend opens popup to this URL
   * 2. We redirect to GitHub OAuth consent
   * 3. GitHub redirects back to /auth/github/callback
   * 4. Callback sends postMessage to opener and closes popup
   */
  private async handleGitHubConnect(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const result = await this.authHandler.initGitHubOAuth()

      if (!result.success || !result.url) {
        this.sendOAuthResult(res, {
          success: false,
          error: result.error || "GitHub authentication not configured",
        })
        return
      }

      // Redirect to GitHub OAuth
      res.writeHead(302, { Location: result.url })
      res.end()
    } catch (error) {
      console.error("[HttpAuthHandler] GitHub connect error:", error)
      captureException(error, { context: "http-auth-github-connect" })
      this.sendOAuthResult(res, {
        success: false,
        error: "Failed to start GitHub authentication",
      })
    }
  }

  /**
   * Handle GitHub OAuth initialization
   * POST /api/auth/github/init
   * Returns the GitHub OAuth URL to redirect the user to
   */
  private async handleGitHubInit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const result = await this.authHandler.initGitHubOAuth()

      if (!result.success) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            error: result.error || "Failed to initialize GitHub OAuth",
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
      console.error("[HttpAuthHandler] GitHub init error:", error)
      captureException(error, { context: "http-auth-github-init" })
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Internal server error" }))
    }
  }

  /**
   * Handle GitHub OAuth callback
   *
   * After user authorizes in GitHub, they're redirected here with:
   * - code: Authorization code to exchange for tokens
   * - state: CSRF protection token
   */
  private async handleGitHubCallback(
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
        console.log(`[HttpAuthHandler] GitHub OAuth error: ${error}`)
        this.sendOAuthResult(res, {
          success: false,
          error: `GitHub authentication failed: ${error}`,
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
      const result = await this.authHandler.handleGitHubCallback(code, state, metadata)

      if (!result.success) {
        this.sendOAuthResult(res, {
          success: false,
          error: result.error || "Authentication failed",
        })
        return
      }

      // Success! Install the httpOnly session cookie (same as Google/Microsoft flow)
      res.setHeader("Set-Cookie", buildSessionCookie(result.sessionToken!, req))
      this.sendOAuthResult(res, {
        success: true,
        token: result.sessionToken!,
        userId: result.userId!,
        user: result.user!,
      })
    } catch (error) {
      console.error("[HttpAuthHandler] GitHub callback error:", error)
      captureException(error, { context: "http-auth-github-callback" })
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
    // See http-mca-auth-handler.sendOAuthResult for the same reasoning: in
    // dev Metro and the backend live on different origins, so a strict
    // target silences the popup→opener postMessage. Relax only in dev.
    const postMessageTarget = process.env.NODE_ENV === "production" ? appUrl : "*"

    const { html, contentSecurityPolicy } = renderOAuthResultPage({
      title: result.success ? "Signed in · Teros" : "Sign-in failed · Teros",
      success: result.success,
      heading: result.success ? "Signed in" : "Couldn't sign you in",
      lead: result.success
        ? "Taking you back to Teros."
        : "The provider didn't let us finish. You can try again from Teros.",
      error: result.error,
      returnUrl: appUrl,
      staticBaseUrl: config.static.baseUrl,
      script: `
    const result = ${scriptJson(result)};
    // Popup flow: hand the result to the opener and close.
    if (window.opener) {
      try {
        window.opener.postMessage({ type: 'oauth_result', ...result }, ${scriptJson(postMessageTarget)});
        setTimeout(() => window.close(), 900);
      } catch (e) {
        console.error('Failed to send to opener:', e);
      }
    } else if (result.success) {
      // No popup — full-page redirect flow. Land on the app root.
      setTimeout(() => { window.location.href = ${scriptJson(appUrl)}; }, 1500);
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
