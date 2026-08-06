/**
 * Google Calendar API Client Manager
 *
 * Manages OAuth2 authentication and exposes the v3 Calendar client.
 * Tokens are fetched on-demand from backend via context.getSystemSecrets/getUserSecrets.
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
  REFRESH_TOKEN?: string
  EMAIL?: string
  EXPIRY_DATE?: string
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

/**
 * Get an authenticated Google Calendar client.
 * Caches the session by access token; refreshes when expired.
 */
export async function getCalendarSession(context: SecretsContext): Promise<CalendarSession> {
  const systemSecrets = (await context.getSystemSecrets()) as CalendarSecrets
  const userSecrets = (await context.getUserSecrets()) as CalendarSecrets
  const secrets = { ...systemSecrets, ...userSecrets }

  if (!secrets.CLIENT_ID || !secrets.CLIENT_SECRET) {
    throw new Error(
      "Google OAuth credentials not configured. Missing CLIENT_ID or CLIENT_SECRET in system secrets.",
    )
  }
  if (!secrets.ACCESS_TOKEN || !secrets.REFRESH_TOKEN) {
    throw new Error("Google account not connected. Please connect your Google account.")
  }

  if (cachedSession && cachedAccessToken === secrets.ACCESS_TOKEN) {
    return cachedSession
  }

  const redirectUri = parseRedirectUri(secrets.REDIRECT_URIS)
  const oauth2Client = new google.auth.OAuth2(secrets.CLIENT_ID, secrets.CLIENT_SECRET, redirectUri)
  const expiryDate = secrets.EXPIRY_DATE ? Number.parseInt(secrets.EXPIRY_DATE, 10) : undefined
  oauth2Client.setCredentials({
    access_token: secrets.ACCESS_TOKEN,
    refresh_token: secrets.REFRESH_TOKEN,
    expiry_date: expiryDate,
  })

  const needsRefresh = expiryDate !== undefined && expiryDate < Date.now() + 60_000
  if (needsRefresh) {
    const { credentials } = await oauth2Client.refreshAccessToken()
    oauth2Client.setCredentials(credentials)
  }

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

  cachedSession = {
    calendar,
    oauth2Client,
    email,
    displayName: deriveDisplayName(secrets.EMAIL),
    getUserTimeZone,
  }
  cachedAccessToken = secrets.ACCESS_TOKEN
  return cachedSession
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
