/**
 * Session cookie helpers (Req 6.6.1 — web session persistence).
 *
 * On web the session token is persisted in an httpOnly cookie scoped to the
 * backend origin instead of localStorage, so it survives page reloads without
 * being readable by JS (no XSS exfiltration). The cookie name matches the
 * `teros_session` fallback that the HTTP auth handlers already accept.
 *
 * SameSite=Lax is enough: the app (os.teros.ai) and the backend (be.teros.ai)
 * are same-site (both under teros.ai), so the cookie travels on fetch with
 * `credentials: 'include'` and on the WebSocket upgrade without SameSite=None.
 */

import type { IncomingMessage } from "http"

export const SESSION_COOKIE_NAME = "teros_session"

/** Keep in sync with SESSION_DURATION_MS in auth/session-service.ts (30 days). */
const SESSION_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60

/**
 * Parse the Cookie header into a name→value map.
 */
export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie
  const cookies: Record<string, string> = {}
  if (!header) return cookies
  for (const part of header.split(";")) {
    const idx = part.indexOf("=")
    if (idx === -1) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key) {
      try {
        cookies[key] = decodeURIComponent(value)
      } catch {
        cookies[key] = value
      }
    }
  }
  return cookies
}

/**
 * Resolve the session token carried by an HTTP request (F2).
 *
 * Priority — Authorization header first, cookie second:
 * 1. `Authorization: Bearer <token>` — native apps and web flows that hold
 *    the token in memory (login, OAuth popup, impersonation). Unchanged.
 * 2. `teros_session` httpOnly cookie — web after a page reload, where the
 *    token is no longer readable by JS. The cookie is same-site (SameSite=Lax
 *    under teros.ai), so it travels on these cross-origin-but-same-site
 *    fetches with `credentials: 'include'`.
 *
 * Returns null when neither carries a token. Callers validate it with
 * AuthService.validateSession exactly like before — this helper only decides
 * WHERE the token comes from, never whether it is valid.
 */
export function extractSessionToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7)
  }
  return parseCookies(req)[SESSION_COOKIE_NAME] ?? null
}

/**
 * True when the original client connection was HTTPS — directly or via a
 * reverse proxy (X-Forwarded-Proto). Secure cookies set over plain HTTP are
 * rejected by browsers, so the attribute must be conditional.
 */
export function isSecureRequest(req: IncomingMessage): boolean {
  const proto = req.headers["x-forwarded-proto"]
  const first = Array.isArray(proto) ? proto[0] : proto
  if (first) return first.split(",")[0].trim() === "https"
  return (req.socket as { encrypted?: boolean }).encrypted === true
}

/**
 * Build the Set-Cookie value that installs the session cookie.
 */
export function buildSessionCookie(token: string, req: IncomingMessage): string {
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${SESSION_COOKIE_MAX_AGE_S}`,
    "HttpOnly",
    "SameSite=Lax",
  ]
  if (isSecureRequest(req)) attrs.push("Secure")
  return attrs.join("; ")
}

/**
 * Build the Set-Cookie value that clears the session cookie (logout).
 */
export function buildSessionCookieClear(req: IncomingMessage): string {
  const attrs = [`${SESSION_COOKIE_NAME}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax"]
  if (isSecureRequest(req)) attrs.push("Secure")
  return attrs.join("; ")
}
