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
import { applyDownloadSafetyHeaders } from '../lib/content-safety'
import { extractClientIp, isIpAllowed, resolveAllowedOrigin, timingSafeStringEqual } from '../lib/http-security'
import { enforceHttpRateLimit, type RateLimiter } from '../services/rate-limiter'
import { buildHealthReport } from './health'
import { EventHandler, type ScheduledEvent } from '../handlers/event-handler'
import { AppWebhookHandler } from '../handlers/app-webhook-handler'
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
  mcaCallbackRoutes: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>
  providerOAuthRoutes: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>
  g2Routes: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>
  /**
   * Prometheus /metrics endpoint. Optional: if not provided, /metrics responds 404.
   * Constructed by createMetricsRoute(deps) in routes/metrics-routes.ts.
   */
  metricsRoute?: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>
  authHandler: HttpAuthHandler
  mcaAuthHandler: HttpMcaAuthHandler
  githubWebhookHandler: GitHubWebhookHandler
  /** F4·C1 — Latitude signal webhook. Absent when LATITUDE_WEBHOOK_SECRET is unset. */
  latitudeWebhookHandler?: LatitudeWebhookHandler
  appWebhookHandler: AppWebhookHandler
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
  /** Mongo-backed rate limiter. Optional: absent disables HTTP rate limiting. */
  rateLimiter?: RateLimiter
  db: Db
}

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
    mcaCallbackRoutes,
    providerOAuthRoutes,
    g2Routes,
    metricsRoute,
    authHandler,
    mcaAuthHandler,
    githubWebhookHandler,
    latitudeWebhookHandler,
    appWebhookHandler,
    stripeWebhookHandler,
    uploadHandler,
    mediaHandler,
    fileHandler,
    shareHandler,
    eventHandler,
    mcaEventSubscriptionService,
    sessionManager,
    mcaManager,
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
    const allowedOrigin = resolveAllowedOrigin(req.headers.origin, config.security.corsAllowedOrigins)
    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
      if (allowedOrigin !== '*') res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    // Handle preflight (never rate-limited)
    if (method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
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
      if (await appWebhookHandler.handleRoute(req, res, url)) return
    }

    // OAuth callback routes
    if (url.startsWith('/auth/') || url.startsWith('/api/auth/')) {
      if (await mcaAuthHandler.handleRoute(req, res, url)) return
      if (await authHandler.handleRoute(req, res, url)) return
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
      if (!isIpAllowed(clientIp, config.security.metricsAllowedIps)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        res.end('Forbidden')
        return
      }
      if (await metricsRoute(req, res, url)) return
    }

    // Health check — probes critical deps so a broken deploy fails the gate (TER-418)
    if (url === '/health') {
      const { statusCode, body } = await buildHealthReport({ db, sessionManager, mcaManager })
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

    // Share API (create/delete shares + public share viewer)
    if (url.startsWith('/api/share') || url.startsWith('/share/')) {
      if (await shareHandler.handleRoute(req, res, url)) return
    }

    // Event API (for scheduler — direct channel injection)
    if (url === '/api/event' && method === 'POST') {
      await handleEventRoute(req, res, eventHandler)
      return
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

    // Board dependency routes
    if (url.startsWith('/api/tasks/')) {
      if (await boardRoutes(req, res, url)) return
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
 * Handle /api/event route
 */
async function handleEventRoute(
  req: IncomingMessage,
  res: ServerResponse,
  eventHandler: EventHandler,
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
      console.warn('⚠️  Unauthorized attempt to /api/event - invalid or missing token')
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk)
    }
    const body = Buffer.concat(chunks).toString()
    const event: ScheduledEvent = JSON.parse(body)

    if (!event.channelId || !event.message || !event.eventType) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          success: false,
          error: 'Missing required fields: channelId, message, eventType',
        }),
      )
      return
    }

    const result = await eventHandler.handleScheduledEvent(event)

    res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (error) {
    console.error('❌ Error handling /api/event:', error)
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
  const filePath = resolveStaticFilePath(url)
  if (!filePath) {
    res.writeHead(404)
    res.end('Not Found')
    return
  }
  const ext = extname(filePath).toLowerCase()
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream'

  try {
    const data = await readFile(filePath)
    // Force-attachment + nosniff for browser-executable types (Stored XSS, C-5).
    // Shared with the media handler via applyDownloadSafetyHeaders so the two
    // serving paths can't drift.
    const headers = applyDownloadSafetyHeaders(
      {
        'Content-Type': mimeType,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
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
    const headers = applyDownloadSafetyHeaders(
      {
        'Content-Type': mimeType,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
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
    res.writeHead(200, {
      'Content-Type': mimeType,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
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
