/**
 * Backend session-cookie client (web session persistence, Req 6.6.1).
 *
 * On web the session token lives only in Zustand in-memory state — never in
 * localStorage — so a page reload would log the user out. The backend persists
 * the token in an httpOnly cookie scoped to its own origin (set on login,
 * cleared on logout); these helpers talk to GET/POST/DELETE /auth/session to
 * restore, install and clear that cookie. JS can never read the cookie itself,
 * which is the point: XSS cannot exfiltrate it from storage.
 *
 * F2: GET /auth/session returns the session STATE only (userId, user,
 * expiresAt, impersonation) — never the token. The web client authenticates
 * its WebSocket with the cookie (auth method "cookie") and sends the cookie
 * on HTTP calls with `credentials: 'include'` instead of holding a Bearer
 * token it can no longer obtain.
 *
 * All helpers are no-ops outside web (native persists the token in
 * SecureStorage and doesn't need the cookie).
 */

import { Platform } from "react-native"
import { wsUrl as resolveWsUrl } from "../config/runtime"

const isWeb = Platform.OS === "web"

/**
 * Shape returned by GET /auth/session — session state WITHOUT the token (F2).
 * The token never crosses this boundary; the cookie is the only carrier.
 */
export interface RestoredSession {
  userId: string
  expiresAt?: string
  user?: {
    profile?: { displayName?: string; email?: string; avatarUrl?: string; locale?: string; timezone?: string }
    role?: string
    termsAcceptedAt?: string
    onboardingCompletedAt?: string
    accessGranted?: boolean
    lastChangelogSeen?: string
  }
  impersonation?: {
    isImpersonating: boolean
    impersonatedBy: string
    impersonatedByName: string
  }
}

function backendHttpBaseUrl(): string | null {
  const wsUrl = resolveWsUrl()
  if (!wsUrl) return null
  return wsUrl
    .replace(/^wss:/, "https:")
    .replace(/^ws:/, "http:")
    .replace(/\/ws\/?$/, "")
}

/**
 * Try to restore the session STATE from the backend cookie (page reload path).
 * Returns null when there is no valid cookie — the caller falls back to the
 * login screen. The token is intentionally NOT part of the result (F2): the
 * caller marks the session as cookie-authenticated and the WS handshake uses
 * auth method "cookie".
 */
export async function restoreSessionFromCookie(): Promise<RestoredSession | null> {
  if (!isWeb) return null
  const base = backendHttpBaseUrl()
  if (!base) return null
  try {
    const res = await fetch(`${base}/auth/session`, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    })
    if (!res.ok) return null
    const data = (await res.json()) as { success?: boolean } & RestoredSession
    return data?.success && data?.userId ? data : null
  } catch {
    return null
  }
}

/**
 * Install the session cookie for a freshly obtained token (login,
 * impersonation). Fire-and-forget: cookie installation failing must never
 * block the login flow — worst case the session doesn't survive a reload.
 */
export function installSessionCookie(sessionToken: string): void {
  if (!isWeb || !sessionToken) return
  const base = backendHttpBaseUrl()
  if (!base) return
  fetch(`${base}/auth/session`, {
    method: "POST",
    credentials: "include",
    headers: { Authorization: `Bearer ${sessionToken}` },
  }).catch(() => {
    /* best-effort */
  })
}

/**
 * Clear the session cookie (logout). The backend also revokes the session
 * server-side (best-effort).
 */
export async function clearSessionCookie(): Promise<void> {
  if (!isWeb) return
  const base = backendHttpBaseUrl()
  if (!base) return
  try {
    await fetch(`${base}/auth/session`, { method: "DELETE", credentials: "include" })
  } catch {
    /* best-effort */
  }
}
