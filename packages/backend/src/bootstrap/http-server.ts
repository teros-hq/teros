/**
 * HTTP Server
 *
 * HTTP request handler and related route helpers.
 * Extracted from index.ts for maintainability.
 */

import { readFile } from 'fs/promises'
import type { IncomingMessage, ServerResponse } from 'http'
import { basename, dirname, extname, join, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import type { Db } from 'mongodb'
import { config } from '../config'
import { applyDownloadSafetyHeaders, withTextCharset } from '../lib/content-safety'
import { parseResizeOptions, isResizableImage, resizeImage } from '../lib/image-resize'
import { buildHstsHeader, extractClientIp, isIpAllowed, isOriginAllowed, resolveAllowedOrigin, shouldSetHsts, timingSafeStringEqual, isMetricsRequestAllowed } from '../lib/http-security'
import { enforceHttpRateLimit, type RateLimiter } from '../services/rate-limiter'
import { checkApiKeyScope, costsAccessLogger } from '../services/costs-auth'
import { buildHealthReport } from './health'
import { getDevAutologin, isDevAutologinRequestAllowed } from '../auth/dev-autologin'
import { EventHandler, type ScheduledEvent } from '../handlers/event-handler'
import { AppWebhookHandler } from '../handlers/app-webhook-handler'
import { FlowWebhookHandler } from '../handlers/flow-webhook-handler'
import { GitHubWebhookHandler } from '../handlers/github-webhook-handler'
import type { LatitudeWebhookHandler } from '../handlers/latitude-webhook-handler'
import { HttpAuthHandler } from '../handlers/http-auth-handler'
import { HttpFileHandler } from '../handlers/http-file-handler'
import { HttpMcaAuthHandler } from '../handlers/http-mca-auth-handler'
import { HttpMediaHandler } from '../handlers/http-media-handler'
import { HttpShareHandler } from '../handlers/http-share-handler'
import { HttpUploadHandler } from '../handlers/http-upload-handler'
import { secrets } from '../secrets/secrets-manager'
import { getEmailService } from '../services/email-service'
import { McaManager } from '../services/mca-manager'
import { MCAEventSubscriptionService } from '../services/mca-event-subscription-service'
import { SessionManager } from '../services/session-manager'
import { generateId } from '@teros/core'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MIME_TYPES: Record<string, string> = {
  // Fonts (the OAuth return page's Saans / Prody)
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  // Images
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  // Documents
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Text
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.ts': 'application/typescript',
  // Archives
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
  // Video
  '.mp4': 'video/mp4',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
}

// Resolve relative to the compiled output location (packages/backend/dist → packages/backend/)
export const STATIC_DIR = join(__dirname, '..', '..', 'static')
export const UPLOADS_DIR = join(__dirname, '..', '..', 'uploads')
export const PUBLIC_DIR = join(__dirname, '..', '..', 'public')

/**
 * Path-containment guard (SEC-2 / M4). Resolves `requested` under `baseDir` and
 * returns the absolute path only if it stays inside `baseDir`; returns null on
 * any escape (`..`, absolute, encoded). Callers MUST 404 on null and read the
 * RETURNED path — never re-join `requested`. `/static/` has its own richer guard
 * (resolveStaticFilePath); this covers the sibling `/uploads` and `/public` roots.
 */
export function resolveWithinDir(baseDir: string, requested: string): string | null {
  const base = resolve(baseDir)
  const target = resolve(base, requested)
  if (target !== base && !target.startsWith(base + sep)) return null
  return target
}

// ---------------------------------------------------------------------------
// HttpHandlers interface
// ---------------------------------------------------------------------------

export interface HttpHandlers {
  adminRoutes: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>
  boardRoutes: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>
  automateRoutes: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>
  mcaCallbackRoutes: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>
  providerOAuthRoutes: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>
  g2Routes: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>
  /** Even Terminal /api/* routes — SSE + REST contract for Even G2 Terminal Mode */
  terminalRoutes?: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>
  /**
   * Prometheus /metrics endpoint. Optional: if not provided, /metrics responds 404.
   * Constructed by createMetricsRoute(deps) in routes/metrics-routes.ts.
   */
  metricsRoute?: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>
  /**
   * Costs API (/api/costs/*) — read-only inference-cost aggregations for the
   * external panel (task_4b1fe21d28b84452). Bearer-token auth; disabled (404)
   * when no token is configured. Constructed by createCostsRoutes in
   * routes/costs-routes.ts.
   */
  costsRoutes?: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>
  /**
   * Tasks MCP endpoint (POST /mcp/tasks) — the Claude Code runner's tool
   * bridge (CCR-REQ-4). Bearer tasks:run token inside the handler.
   */
  mcpTasksRoutes?: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>
  authHandler: HttpAuthHandler
  mcaAuthHandler: HttpMcaAuthHandler
  githubWebhookHandler: GitHubWebhookHandler
  /** F4·C1 — Latitude signal webhook. Absent when LATITUDE_WEBHOOK_SECRET is unset. */
  latitudeWebhookHandler?: LatitudeWebhookHandler
  appWebhookHandler: AppWebhookHandler
  flowWebhookHandler: FlowWebhookHandler
  /** Stripe webhook (FASE 4). Optional: absent when Stripe is not configured. */
  stripeWebhookHandler?: import('../handlers/stripe-webhook-handler').StripeWebhookHandler
  uploadHandler: HttpUploadHandler
  mediaHandler: HttpMediaHandler
  fileHandler: HttpFileHandler
  shareHandler: HttpShareHandler
  eventHandler: EventHandler
  mcaEventSubscriptionService: MCAEventSubscriptionService
  sessionManager: SessionManager
  mcaManager: McaManager | null
  /** Agent Apps routes (station → host push announcements). Optional: absent when Agent Apps is disabled. */
  agentAppsRoutes?: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>
  /** Agent Apps storage routes (standalone — always available, no bridge needed). */
  agentAppsStorageRoutes?: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>
  /** Mongo-backed rate limiter. Optional: absent disables HTTP rate limiting. */
  rateLimiter?: RateLimiter
  db: Db
}

// ---------------------------------------------------------------------------
// Anti-CSRF constants (Req 3.1.5)
// ---------------------------------------------------------------------------

/** HTTP methods that change server state and must be CSRF-protected. */
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH'])

/**
 * Route prefixes exempt from Origin/Referer validation. These endpoints use
 * non-browser auth (HMAC signatures, internal tokens, OAuth `state` params, or
 * Bearer-token hardware API) and are not vulnerable to CSRF:
 *   - /webhooks/*          — signature-verified machine webhooks
 *   - /mca/callback/       — internal MCA token auth
 *   - /api/event            — MCA internal token
 *   - /api/mca-event        — MCA internal token
 *   - /api/feedback/submit  — MCA feedback token
 *   - /auth/, /api/auth/    — OAuth GET redirects (state-param CSRF protection)
 *   - /g2                   — Bearer-token hardware API (G2 glasses)
 *   - /terminal             — Bearer-token Even Terminal API (G2 Terminal Mode)
 *   - /api/events           — SSE stream (Bearer token, not browser)
 *   - /api/prompt           — Even Terminal prompt (Bearer token)
 *   - /api/permission-response — Even Terminal permission (Bearer token)
 *   - /api/question-response — Even Terminal question (Bearer token)
 *   - /api/interrupt        — Even Terminal interrupt (Bearer token)
 *   - /admin/               — Bearer-token admin API (ADMIN_API_KEY, not browser cookies)
 */
const CSRF_EXEMPT_PREFIXES = [
  '/webhooks/',
  '/api/v1/webhooks/', // Automate public webhooks — unauthenticated by design, the URL token is the secret
  '/mca/callback/',
  '/api/mca-event',
  '/api/feedback/submit',
  '/auth/',
  '/api/auth/',
  '/g2',
  '/mcp/', // Tasks MCP endpoint — Bearer tasks:run token, no session cookie
  '/terminal',
  '/api/events',
  '/api/prompt',
  '/api/permission-response',
  '/api/question-response',
  '/api/interrupt',
  '/api/codex/',
  '/api/media/',
  '/api/agent-apps/',
  '/admin/',
]

// ---------------------------------------------------------------------------
// createHttpHandler
// ---------------------------------------------------------------------------

/**
 * Create HTTP request handler
 */
export function createHttpHandler(handlers: HttpHandlers) {
  const {
    adminRoutes,
    boardRoutes,
    automateRoutes,
    mcaCallbackRoutes,
    providerOAuthRoutes,
    g2Routes,
    terminalRoutes,
    metricsRoute,
    costsRoutes,
    mcpTasksRoutes,
    authHandler,
    mcaAuthHandler,
    githubWebhookHandler,
    latitudeWebhookHandler,
    appWebhookHandler,
    flowWebhookHandler,
    stripeWebhookHandler,
    uploadHandler,
    mediaHandler,
    fileHandler,
    shareHandler,
    eventHandler,
    mcaEventSubscriptionService,
    sessionManager,
    mcaManager,
    agentAppsRoutes,
    agentAppsStorageRoutes,
    rateLimiter,
    db,
  } = handlers

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '/'
    const method = req.method || 'GET'

    // Debug log for static files
    if (url.startsWith('/static/')) {
      console.log(`[HTTP] Static file request: ${method} ${url}`)
    }

    // Debug log for callback routes
    if (url.startsWith('/mca/callback/')) {
      console.log(`[HTTP] Received MCA callback: ${method} ${url}`)
    }

    // CORS — reflect only allowlisted origins for the API/WS (never a bare '*').
    // Disallowed origins get no ACAO header, so the browser blocks the response.
    //
    // Vary: Origin is set UNCONDITIONALLY — also for requests WITHOUT an Origin
    // header (e.g. no-cors <img> loads of /static/mcas/... icons). Those
    // responses are publicly cacheable (Cache-Control: public, max-age=86400),
    // and the same URL is fetched two ways: no-cors <img> (no Origin → no ACAO)
    // and CORS fetch() (with Origin → ACAO reflected). Without `Vary: Origin`
    // on BOTH variants, a shared cache cannot tell them apart and may serve the
    // no-ACAO variant to a later CORS fetch — the browser then rejects it as
    // "No 'Access-Control-Allow-Origin' header" and every MCA icon falls back
    // to '?' (prod incident 2026-10-01). With Vary, each Origin keys its own
    // cache entry and the variants never cross.
    res.setHeader('Vary', 'Origin')
    const allowedOrigin = resolveAllowedOrigin(req.headers.origin, config.security.corsAllowedOrigins)
    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
      if (allowedOrigin !== '*') {
        // Needed for fetch with credentials: 'include' (session cookie, Req 6.6.1).
        // Browsers reject credentialed responses with ACAO '*', hence the guard.
        res.setHeader('Access-Control-Allow-Credentials', 'true')
      }
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    // HSTS — Strict-Transport-Security (Req 4.1.1). Tells browsers to always use
    // HTTPS for the site, preventing SSL-stripping and protocol-downgrade attacks.
    // Only set when the original client connection was HTTPS (gated by
    // X-Forwarded-Proto when behind a reverse proxy). Browsers ignore HSTS over
    // plain HTTP (RFC 6797 §8.1), so in local dev (trustProxy=false) we skip it.
    if (config.security.hsts.enabled && shouldSetHsts(req, config.security.trustProxy)) {
      res.setHeader(
        'Strict-Transport-Security',
        buildHstsHeader(
          config.security.hsts.maxAgeSeconds,
          config.security.hsts.includeSubDomains,
          config.security.hsts.preload,
        ),
      )
    }

    // Handle preflight (never rate-limited)
    if (method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // ─── Anti-CSRF: Origin/Referer validation for state-changing methods ───────
    // Req 3.1.5 — defense-in-depth against Cross-Site Request Forgery.
    //
    // Browsers send the `Origin` header on all cross-origin and same-origin
    // POST/PUT/DELETE/PATCH requests. We validate it (or the `Referer` fallback)
    // against the same CORS allowlist used above. A forged request from a
    // third-party site will carry the attacker's origin, which won't match.
    //
    // Exempt routes (CSRF_EXEMPT_PREFIXES) use their own non-browser auth and
    // are not vulnerable to CSRF — see the comment at the constant definition.
    if (
      STATE_CHANGING_METHODS.has(method) &&
      !CSRF_EXEMPT_PREFIXES.some((prefix) => url.startsWith(prefix))
    ) {
      const origin = req.headers['origin']
      const referer = req.headers['referer']
      if (!isOriginAllowed(
        Array.isArray(origin) ? origin[0] : origin,
        Array.isArray(referer) ? referer[0] : referer,
        config.security.corsAllowedOrigins,
      )) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          success: false,
          error: 'Cross-origin request blocked',
        }))
        return
      }
    }

    // Rate limiting — Mongo-backed, coordinated across instances. Excludes
    // static/content + signature/token-authenticated machine routes (see
    // isRateLimitedPath). Fails open if the counter store errors.
    if (rateLimiter) {
      const clientIp = extractClientIp(req, config.security.trustProxy)
      const denied = await enforceHttpRateLimit(rateLimiter, config.security.rateLimit, clientIp, url)
      if (denied) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': String(denied.retryAfterSeconds),
        })
        res.end(
          JSON.stringify({
            success: false,
            error: 'Too many requests',
            scope: denied.scope,
            retryAfterSeconds: denied.retryAfterSeconds,
          }),
        )
        return
      }
    }

    // ─── Costs API key scope guard (task_6de67c22b163387a) ────────────────────
    // The static X-API-Key authorizes EXACTLY the /api/costs/* read-only
    // surface. A request presenting the header against ANY other path is a
    // scope violation — reject it here, BEFORE any routing, with a generic
    // 403 that reveals nothing about what exists. Placed AFTER the rate
    // limiter so an attacker spraying the header on random paths is
    // throttled per-IP before reaching this guard (and its audit writes).
    // This runs even when the costs surface is disabled (no key
    // configured): the header still means "I am the costs key holder", and
    // it must never buy anything outside costs. Validity of the presented
    // key is irrelevant here — the guard is about WHERE the credential may
    // be used, not whether it is correct.
    const apiKeyScope = checkApiKeyScope(req, url)
    if (apiKeyScope.violation) {
      costsAccessLogger.log({
        timestamp: new Date(),
        endpoint: apiKeyScope.path,
        env: 'edge',
        ip: extractClientIp(req, config.security.trustProxy),
        userAgent: req.headers['user-agent'] as string | undefined,
        outcome: 'scope_forbidden',
        status: 403,
        keyFingerprint: apiKeyScope.keyFingerprint,
      })
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'FORBIDDEN', message: 'Forbidden' }))
      return
    }

    // GitHub App webhook (signature-verified — independent of session auth).
    if (url.startsWith('/webhooks/github')) {
      if (await githubWebhookHandler.handleRoute(req, res, url)) return
    }

    // Latitude signal webhook (HMAC-verified, F4·C1). Only when the secret is wired.
    if (latitudeWebhookHandler && url.startsWith('/webhooks/latitude')) {
      if (await latitudeWebhookHandler.handleRoute(req, res, url)) return
    }

    // Stripe webhook (signature-verified, FASE 4). Only when Stripe is wired.
    if (stripeWebhookHandler && url.startsWith('/webhooks/stripe')) {
      if (await stripeWebhookHandler.handleRoute(req, res, url)) return
    }

    // Generic per-app webhooks (any MCA with webhook support)
    if (url.startsWith('/webhooks/apps/')) {
    // Flow webhook triggers (Phase 4) — POST /webhooks/flow/:token
    if (url.startsWith('/webhooks/flow/')) {
      if (await flowWebhookHandler.handleRoute(req, res, url)) return
    }

      if (await appWebhookHandler.handleRoute(req, res, url)) return
    }

    // OAuth callback routes
    if (url.startsWith('/auth/') || url.startsWith('/api/auth/')) {
      if (await mcaAuthHandler.handleRoute(req, res, url)) return
      if (await authHandler.handleRoute(req, res, url)) return
    }

    // Dev auto-login capability probe (local dev only). When the feature is off
    // — always in production — or the request isn't a direct local one, this
    // falls through to the normal 404, so prod has no such route at all.
    if (url === '/api/dev-autologin' && method === 'GET' && isDevAutologinRequestAllowed(req)) {
      const devState = getDevAutologin()
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({
        devAutologin: true,
        user: devState.enabled ? devState.userEmail : null,
      }))
      return
    }

    // Redirect root to health check
    if (url === '/') {
      res.writeHead(302, { Location: '/health' })
      res.end()
      return
    }

    // Prometheus metrics endpoint (agent usage instrumentation). Gated to
    // internal IPs as defense-in-depth — the reverse proxy is the first line.
    if (url === '/metrics' && metricsRoute) {
      const clientIp = extractClientIp(req, config.security.trustProxy)
      const allowed = isMetricsRequestAllowed({
        clientIp,
        allowlist: config.security.metricsAllowedIps,
        trustProxy: config.security.trustProxy,
        production: process.env.NODE_ENV === 'production',
        authorization: req.headers.authorization,
        token: config.security.metricsToken,
      })
      if (!allowed) {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        res.end('Forbidden')
        return
      }
      if (await metricsRoute(req, res, url)) return
    }

    // Health check — probes critical deps so a broken deploy fails the gate (TER-418)
    if (url === '/health') {
      const { statusCode, body } = await buildHealthReport({ db, sessionManager, mcaManager, release: process.env.TEROS_RELEASE || null })
      res.writeHead(statusCode, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
      return
    }

    // Upload API
    if (url.startsWith('/api/upload/')) {
      if (await uploadHandler.handleRoute(req, res, url)) return
    }

    // Media API (for messaging multimedia)
    if (url.startsWith('/api/media/') || url.startsWith('/media/')) {
      if (await mediaHandler.handleRoute(req, res, url)) return
    }

    // File API (serves workspace files for HtmlFileBubble)
    if (url.startsWith('/api/files')) {
      if (await fileHandler.handleRoute(req, res, url)) return
    }

    // Public share viewer — GET /share/:shareId only (the public link itself;
    // share management moved to the WS `share` domain, no /api/share REST)
    if (url.startsWith('/share/')) {
      if (await shareHandler.handleRoute(req, res, url)) return
    }

    // Public object storage — serves object files by objectId (no auth).
    // Registered before /api/agent-apps/ so it takes priority for /objects/*.
    // HEAD passes through too — the router answers it (200 + Content-Length,
    // empty body). The edge used to filter `method === 'GET'` here, so HEAD
    // fell through to the plain 404 below and `curl -I` "proved" intact
    // objects destroyed (incident 2026-11-01: 29MB video).
    if (url.startsWith('/objects/') && (method === 'GET' || method === 'HEAD')) {
      if (agentAppsStorageRoutes && await agentAppsStorageRoutes(req, res, url)) return
    }

    // Agent Apps routes (station → host push announcements)
    if (url.startsWith('/api/agent-apps/')) {
      // Storage routes are always available (no bridge needed)
      if (agentAppsStorageRoutes && await agentAppsStorageRoutes(req, res, url)) return
      // Bridge-dependent routes (announce, stations, callback)
      if (agentAppsRoutes && await agentAppsRoutes(req, res, url)) return
    }

    // MCA Event API — topic-based dispatch via MCAEventSubscriptionService
    if (url === '/api/mca-event' && method === 'POST') {
      await handleMcaEventRoute(req, res, mcaEventSubscriptionService)
      return
    }

    // Feedback submit API (MCA → Backend)
    if (url === '/api/feedback/submit' && method === 'POST') {
      await handleFeedbackSubmit(req, res, db)
      return
    }

    // G2 routes (Even Realities G2 custom AI engine)
    if (url === '/g2' || url.startsWith('/g2/')) {
      if (await g2Routes(req, res, url)) return
    }

    // Tasks MCP endpoint — the Claude Code runner's tools (Bearer tasks:run token).
    if (mcpTasksRoutes && url.startsWith('/mcp/')) {
      if (await mcpTasksRoutes(req, res, url)) return
    }

    // Terminal routes (Even Terminal /api/* SSE + REST contract for G2 Terminal Mode).
    // Only match the specific Even Terminal paths to avoid intercepting other /api/* routes.
    if (terminalRoutes && (
      url === '/health'
      || url === '/terminal'
      || url.startsWith('/terminal/')
      || url.startsWith('/api/events')
      || url.startsWith('/api/sessions')
      || url.startsWith('/api/prompt')
      || url.startsWith('/api/permission-response')
      || url.startsWith('/api/question-response')
      || url.startsWith('/api/interrupt')
      || url.startsWith('/api/status')
      || url.startsWith('/api/messages')
      || url.startsWith('/api/info')
      || url.startsWith('/api/update-check')
      || url.startsWith('/api/metrics')
      || url.startsWith('/api/codex/')
    )) {
      if (await terminalRoutes(req, res, url)) return
    }

    // Board dependency routes
    if (url.startsWith('/api/tasks/')) {
      if (await boardRoutes(req, res, url)) return
    }

    // Costs API — read-only inference-cost aggregations for the external panel.
    // Bearer-token auth inside the handler; 404 when disabled (no token).
    if (url.startsWith('/api/costs/') && costsRoutes) {
      if (await costsRoutes(req, res, url)) return
    }

    // Automate webhook ingestion routes (public, token-authenticated)
    if (url.startsWith('/api/v1/webhooks/')) {
      if (await automateRoutes(req, res, url)) return
    }

    // Admin routes
    if (url.startsWith('/admin/')) {
      if (await adminRoutes(req, res, url)) return
    }

    // Provider OAuth routes (user LLM providers)
    if (url.startsWith('/api/providers/oauth/')) {
      if (await providerOAuthRoutes(req, res, url)) return
    }

    // MCA callback routes (MCA → Backend)
    if (url.startsWith('/mca/callback/')) {
      if (await mcaCallbackRoutes(req, res, url)) return
    }

    // Static files
    if (url.startsWith('/static/')) {
      await handleStaticFile(req, res, url)
      return
    }

    // Uploaded files (voice notes, etc.)
    if (url.startsWith('/uploads/')) {
      await handleUploadedFile(req, res, url)
      return
    }

    // Public files (e.g. pcm-processor.js for AudioWorklet)
    if (url.startsWith('/pcm-processor.js') || url.startsWith('/public/')) {
      await handlePublicFile(req, res, url)
      return
    }

    res.writeHead(404)
    res.end('Not Found')
  }
}

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------


/**
 * Handle /api/mca-event route — topic-based MCA event dispatch
 *
 * Body: { topic: string, payload: Record<string, unknown> }
 * Dispatches to all matching channel and agent subscriptions via MCAEventSubscriptionService.
 */
async function handleMcaEventRoute(
  req: IncomingMessage,
  res: ServerResponse,
  mcaEventSubscriptionService: MCAEventSubscriptionService,
): Promise<void> {
  try {
    // SECURITY: Validate MCA internal token for service-to-service authentication
    const authHeader = req.headers['authorization']
    const mcaSecret = secrets.getSystem<{ internalToken: string }>('mca')

    if (
      !authHeader ||
      !mcaSecret ||
      !timingSafeStringEqual(authHeader, `Bearer ${mcaSecret.internalToken}`)
    ) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          success: false,
          error: 'Unauthorized: Invalid or missing MCA internal token',
        }),
      )
      console.warn('⚠️  Unauthorized attempt to /api/mca-event - invalid or missing token')
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk)
    }
    const body = Buffer.concat(chunks).toString()
    const event = JSON.parse(body)

    if (!event.topic || typeof event.topic !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: false, error: 'Missing required field: topic' }))
      return
    }

    await mcaEventSubscriptionService.dispatch({
      topic: event.topic,
      payload: event.payload ?? {},
    })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: true }))
  } catch (error) {
    console.error('❌ Error handling /api/mca-event:', error)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      }),
    )
  }
}

/**
 * Handle static file requests
 *
 * For MCA assets: /static/mcas/<mca-id>/<file> → mcas/<mca-id>/static/<file>
 * For other assets: /static/<file> → packages/backend/static/<file>
 */
/**
 * Resolve a `/static/...` URL to an absolute on-disk path.
 *
 * Decodes percent-encoding (so '%3A' → ':' matches a historical avatar filename
 * with ':') and guards against path traversal: the resolved path must stay within
 * its allowed root (STATIC_DIR, or the MCA's own static dir). Returns null when
 * the URI is malformed or escapes its root — the caller serves 404.
 */
export function resolveStaticFilePath(url: string): string | null {
  if (!url.startsWith('/static/')) return null // contrato: solo sirve rutas /static/
  let filename: string
  try {
    filename = decodeURIComponent(url.slice(8)) // Remove '/static/'
  } catch {
    return null // malformed URI sequence
  }

  // MCA assets are served from mcas/<id>/static/; everything else from STATIC_DIR.
  let filePath: string
  let allowedRoot: string
  const mcaMatch = filename.match(/^mcas\/([^/]+)\/(.+)$/)
  if (mcaMatch) {
    const [, mcaId, relativePath] = mcaMatch
    // mcaId debe ser un id simple: '..'/'.' (o separadores) re-anclarían allowedRoot
    // fuera del jail del MCA y evadirían el guard de containment de abajo.
    if (mcaId === '..' || mcaId === '.' || !/^[a-zA-Z0-9._-]+$/.test(mcaId)) return null
    allowedRoot = resolve(config.mca.basePath!, mcaId, 'static')
    filePath = join(allowedRoot, relativePath)
  } else {
    allowedRoot = resolve(STATIC_DIR)
    filePath = join(allowedRoot, filename)
  }

  // Path-traversal guard: with decoding, a crafted '..%2f' could otherwise escape
  // the static root. join() collapses `..`; require the result to stay within root.
  const resolvedPath = resolve(filePath)
  if (resolvedPath !== allowedRoot && !resolvedPath.startsWith(allowedRoot + sep)) {
    return null
  }
  return resolvedPath
}

async function handleStaticFile(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
): Promise<void> {
  // Strip query string for path resolution, keep it for resize params
  const queryIdx = url.indexOf('?')
  const pathOnly = queryIdx >= 0 ? url.slice(0, queryIdx) : url
  const queryString = queryIdx >= 0 ? url.slice(queryIdx) : ''

  const filePath = resolveStaticFilePath(pathOnly)
  if (!filePath) {
    res.writeHead(404)
    res.end('Not Found')
    return
  }

  // Parse URL for resize params
  const parsedUrl = new URL(pathOnly + queryString, 'http://localhost')
  const resizeOptions = parseResizeOptions(parsedUrl)

  // If resize params and file is a resizable image, use Sharp
  if (resizeOptions && isResizableImage(filePath)) {
    try {
      const result = await resizeImage(filePath, resizeOptions)
      const headers = applyDownloadSafetyHeaders(
        {
          'Content-Type': result.contentType,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Cache': result.cached ? 'HIT' : 'MISS',
        },
        result.contentType,
        basename(filePath),
      )
      res.writeHead(200, headers)
      res.end(result.data)
      return
    } catch (error) {
      console.error('[static] Image resize failed:', error)
      // Fall through to serve original on resize failure
    }
  }

  const ext = extname(filePath).toLowerCase()
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream'

  try {
    const data = await readFile(filePath)
    // Force-attachment + nosniff for browser-executable types (Stored XSS, C-5).
    // Shared with the media handler via applyDownloadSafetyHeaders so the two
    // serving paths can't drift.
    // ACAO is set by the main request handler via resolveAllowedOrigin() —
    // do not override it with a wildcard here.
    const headers = applyDownloadSafetyHeaders(
      {
        'Content-Type': mimeType,
        'Cache-Control': 'public, max-age=86400',
      },
      mimeType,
      basename(filePath),
    )
    res.writeHead(200, headers)
    res.end(data)
  } catch (error) {
    res.writeHead(404)
    res.end('Not Found')
  }
}

/**
 * Handle uploaded file requests (voice notes, etc.)
 */
export async function handleUploadedFile(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
): Promise<void> {
  const filename = url.slice(9) // Remove '/uploads/'
  const ext = extname(filename).toLowerCase()

  // Extended MIME types for audio
  const audioMimeTypes: Record<string, string> = {
    ...MIME_TYPES,
    '.webm': 'audio/webm',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.mp4': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.mp3': 'audio/mpeg',
  }

  const mimeType = audioMimeTypes[ext]

  if (!mimeType) {
    res.writeHead(404)
    res.end('Not Found')
    return
  }

  // SEC-2 (M4): reject any path escaping UPLOADS_DIR (e.g. `curl --path-as-is
  // /uploads/../../etc/passwd<audio-ext>`). NOTE: this closes traversal only; the
  // per-file IDOR (low-entropy `Date.now()` filename under a userId dir, served
  // with no auth to satisfy the plain <audio> element) needs signed URLs and is
  // tracked as a follow-up — see the TER-721 description.
  const filePath = resolveWithinDir(UPLOADS_DIR, filename)
  if (!filePath) {
    res.writeHead(404)
    res.end('Not Found')
    return
  }

  try {
    const data = await readFile(filePath)
    // Uploads inherit MIME_TYPES (incl. svg/xml), and image/svg+xml is an allowed
    // upload type — so this third serving path must force-attach browser-executable
    // types too, or it re-opens the same Stored XSS the media/static handlers close.
    // Audio types aren't in FORCE_ATTACHMENT_TYPES, so voice notes stay inline.
    // ACAO is set by the main request handler via resolveAllowedOrigin().
    const headers = applyDownloadSafetyHeaders(
      {
        'Content-Type': mimeType,
        'Cache-Control': 'public, max-age=86400',
      },
      mimeType,
      basename(filename),
    )
    res.writeHead(200, headers)
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('Not Found')
  }
}

/**
 * Handle public file requests (e.g. pcm-processor.js for AudioWorklet)
 *
 * Files in packages/backend/public/ are served at the root path.
 */
async function handlePublicFile(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
): Promise<void> {
  // Map root-level paths to public/ directory
  const filename = url.startsWith('/public/') ? url.slice(8) : url.slice(1) // '/public/x' → 'x', '/x' → 'x'
  const ext = extname(filename).toLowerCase()
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream'

  // SEC-2 (M4): contain under PUBLIC_DIR — same traversal class as /uploads.
  const filePath = resolveWithinDir(PUBLIC_DIR, filename)
  if (!filePath) {
    res.writeHead(404)
    res.end('Not Found')
    return
  }

  try {
    const data = await readFile(filePath)
    // ACAO is set by the main request handler via resolveAllowedOrigin().
    // text/* gets an explicit charset=utf-8 (RFC 9110 has no text/* default —
    // without it browsers guess windows-1252 and UTF-8 content mojibakes).
    // NOTE: no applyDownloadSafetyHeaders here on purpose — this path serves
    // platform-owned assets (e.g. pcm-processor.js), not user uploads, and
    // force-attaching application/javascript would break AudioWorklet loading.
    res.writeHead(200, {
      'Content-Type': withTextCharset(mimeType),
      'Cache-Control': 'public, max-age=86400',
    })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('Not Found')
  }
}

/**
 * Handle /api/feedback/submit — receives bug reports and suggestions from MCA,
 * persists to DB, and sends email notification to support team.
 */
async function handleFeedbackSubmit(
  req: IncomingMessage,
  res: ServerResponse,
  db: Db,
): Promise<void> {
  try {
    // Validate token
    const rawAuthHeader = req.headers['x-feedback-token']
    const authHeader = Array.isArray(rawAuthHeader) ? rawAuthHeader[0] : rawAuthHeader
    const feedbackSecret = secrets.system<{ apiToken: string }>('feedback')

    if (!authHeader || !feedbackSecret || !timingSafeStringEqual(authHeader, feedbackSecret.apiToken)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid or missing feedback token' }))
      console.warn('⚠️  Unauthorized attempt to /api/feedback/submit - invalid or missing token')
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk)
    }
    const bodyStr = Buffer.concat(chunks).toString()
    const body = JSON.parse(bodyStr)

    // Validate required fields
    if (!body.type || !body.title || !body.description || !body.reportedBy) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: false, error: 'Missing required fields: type, title, description, reportedBy' }))
      return
    }

    const feedbackId = generateId('fb')
    const now = new Date().toISOString()

    const feedbackDoc = {
      feedbackId,
      type: body.type,
      title: body.title,
      description: body.description,
      severity: body.severity,
      reportedBy: body.reportedBy,
      reportedByName: body.reportedByName,
      reportedByAvatarUrl: body.reportedByAvatarUrl,
      agentId: body.agentId,
      status: 'open',
      updates: [],
      hasUnreadUpdates: false,
      createdAt: now,
      updatedAt: now,
    }

    await db.collection('feedback').insertOne(feedbackDoc)

    // Resolve agent owner if agentId is provided
    let agentOwnerId: string | undefined
    if (body.agentId) {
      try {
        const agent = await db.collection('agents').findOne(
          { agentId: body.agentId },
          { projection: { ownerId: 1 } },
        )
        agentOwnerId = agent?.ownerId
      } catch {
        // Non-fatal: continue without owner info
      }
    }

    // Send email notification to support
    try {
      const emailService = getEmailService(db)
      await emailService.sendFeedbackNotification('support@teros.ai', {
        TYPE: body.type,
        TYPE_LABEL: body.type === 'bug' ? 'Bug' : 'Suggestion',
        TITLE: body.title,
        SEVERITY: body.severity,
        REPORTED_BY: body.reportedByName || body.reportedBy,
        AGENT_ID: body.agentId || 'N/A',
        OWNER_ID: agentOwnerId || 'N/A',
        DESCRIPTION: body.description,
        FEEDBACK_ID: feedbackId,
        DATE: now,
      })
      console.log(`[Feedback] Email notification sent for ${feedbackId}`)
    } catch (emailErr) {
      console.error('[Feedback] Failed to send email notification:', emailErr)
      // Non-fatal: feedback is saved even if email fails
    }

    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      success: true,
      feedbackId,
      message: 'Feedback submitted successfully',
    }))
  } catch (error) {
    console.error('❌ Error handling /api/feedback/submit:', error)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    }))
  }
}
