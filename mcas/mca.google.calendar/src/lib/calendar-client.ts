/**
 * Google Calendar API Client Manager
 *
 * Manages OAuth2 authentication and exposes the v3 Calendar client.
 * Tokens are fetched on-demand from backend via context.getSystemSecrets/getUserSecrets.
 *
 * TER-388: the backend is the only owner of the refresh_token and serves a
 * fresh access_token from `GET /secrets/user` (lazy refresh, rotation-safe).
 * The container authenticates with that access_token only and never refreshes
 * on its own: doing so would reintroduce the double-owner antipattern that
 * invalidated Google's refresh_token when it rotated.
 */

import type { OAuth2Client } from "google-auth-library"
import { type calendar_v3, google } from "googleapis"

/**
 * Minimal context surface our handlers depend on. Decoupled from the SDK's
 * `ToolContext` and `HttpToolContext` so this module compiles regardless of
 * which transport variant the wrapping `McaServer` resolves to.
 */
export interface SecretsContext {
  getSystemSecrets: () => Promise<Record<string, string>>
  getUserSecrets: () => Promise<Record<string, string>>
}

export interface CalendarSecrets {
  CLIENT_ID?: string
  CLIENT_SECRET?: string
  REDIRECT_URIS?: string
  ACCESS_TOKEN?: string
  EMAIL?: string
}

export interface CalendarSession {
  calendar: calendar_v3.Calendar
  oauth2Client: OAuth2Client
  email: string
  displayName?: string
  /**
   * Resolve the user's IANA timezone (e.g. "Europe/Madrid"). Lazy + cached:
   * first call hits `calendar.settings.get({setting:'timezone'})`, subsequent
   * calls within the same session reuse the result. Falls back to "Etc/UTC"
   * if the call fails (offline / quota / scopes). Used by create-event and
   * update-event when `recurrence` is set without explicit `timeZone` arg —
   * Google rejects recurring events without IANA tz in start/end.
   */
  getUserTimeZone: () => Promise<string>
}

let cachedSession: CalendarSession | null = null
let cachedAccessToken: string | null = null

async function fetchSecrets(context: SecretsContext): Promise<CalendarSecrets> {
  const systemSecrets = (await context.getSystemSecrets()) as CalendarSecrets
  const userSecrets = (await context.getUserSecrets()) as CalendarSecrets
  return { ...systemSecrets, ...userSecrets }
}

function requireAccessToken(secrets: CalendarSecrets): string {
  if (!secrets.CLIENT_ID || !secrets.CLIENT_SECRET) {
    throw new Error(
      "Google OAuth credentials not configured. Missing CLIENT_ID or CLIENT_SECRET in system secrets.",
    )
  }
  if (!secrets.ACCESS_TOKEN) {
    throw new Error("Google account not connected. Please connect your Google account.")
  }
  return secrets.ACCESS_TOKEN
}

function buildCalendarSession(secrets: CalendarSecrets, accessToken: string): CalendarSession {
  const redirectUri = parseRedirectUri(secrets.REDIRECT_URIS)
  const oauth2Client = new google.auth.OAuth2(
    secrets.CLIENT_ID,
    secrets.CLIENT_SECRET,
    redirectUri,
  )

  // Only the access_token is set: googleapis will not auto-refresh, and a 401
  // means "ask the backend for a fresh token".
  oauth2Client.setCredentials({ access_token: accessToken })

  const calendar = google.calendar({ version: "v3", auth: oauth2Client })
  const email = secrets.EMAIL ?? "unknown@gmail.com"

  let userTimeZone: string | null = null
  const getUserTimeZone = async (): Promise<string> => {
    if (userTimeZone) return userTimeZone
    try {
      const { data } = await calendar.settings.get({ setting: "timezone" })
      userTimeZone = data.value || "Etc/UTC"
    } catch {
      userTimeZone = "Etc/UTC"
    }
    return userTimeZone
  }

  return {
    calendar,
    oauth2Client,
    email,
    displayName: deriveDisplayName(secrets.EMAIL),
    getUserTimeZone,
  }
}

/**
 * Get an authenticated Google Calendar client.
 * Caches the session by access token; a changed token rebuilds the session.
 */
export async function getCalendarSession(context: SecretsContext): Promise<CalendarSession> {
  const secrets = await fetchSecrets(context)
  const accessToken = requireAccessToken(secrets)

  if (cachedSession && cachedAccessToken === accessToken) {
    return cachedSession
  }

  cachedSession = buildCalendarSession(secrets, accessToken)
  cachedAccessToken = accessToken
  return cachedSession
}

/**
 * Re-fetch the user's access token from the backend and apply it to the
 * cached session. Callers hold a reference to `session.calendar`, so updating
 * the existing OAuth2Client in place keeps that reference valid.
 */
export async function refreshCalendarSession(context: SecretsContext): Promise<CalendarSession> {
  const secrets = await fetchSecrets(context)
  const accessToken = requireAccessToken(secrets)

  if (cachedSession) {
    cachedSession.oauth2Client.setCredentials({ access_token: accessToken })
    cachedAccessToken = accessToken
    return cachedSession
  }

  cachedSession = buildCalendarSession(secrets, accessToken)
  cachedAccessToken = accessToken
  return cachedSession
}

/**
 * Detect a 401 from googleapis (gaxios shapes differ by version).
 */
export function isAuthError(error: any): boolean {
  return (
    error?.code === 401 ||
    error?.status === 401 ||
    error?.response?.status === 401 ||
    error?.message?.includes("401") ||
    error?.message?.toLowerCase().includes("invalid credentials")
  )
}

/**
 * Wrapper that handles 401 errors: re-fetch secrets once from the backend and
 * retry. Never refreshes the token in the container (TER-388).
 */
export async function withAuthRetry<T>(
  context: SecretsContext,
  operation: () => Promise<T>,
  operationName: string,
): Promise<T> {
  try {
    return await operation()
  } catch (error: any) {
    if (!isAuthError(error)) {
      throw error
    }

    console.error(`[GoogleCalendar] 401 error in ${operationName}, re-fetching credentials...`)
    await refreshCalendarSession(context)
    return await operation()
  }
}

/**
 * Quick credential validation: list 1 calendar to verify token still works.
 */
export async function validateCredentials(context: SecretsContext): Promise<void> {
  const { calendar } = await getCalendarSession(context)
  await calendar.calendarList.list({ maxResults: 1 })
}

function parseRedirectUri(raw?: string): string {
  const fallback = "https://be.teros.ai/auth/callback"
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed[0] : raw
  } catch {
    return raw
  }
}

function deriveDisplayName(email?: string): string | undefined {
  if (!email) return undefined
  const local = email.split("@")[0]
  return local
    .split(/[._-]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ")
}
