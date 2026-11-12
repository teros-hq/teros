/**
 * Microsoft Graph API client — shared module for all Microsoft 365 MCAs.
 *
 * Adapted from the agentapps-private implementation (spec §3.2) to the Teros
 * MCA SDK pattern. Each MCA (OneDrive, Excel, Word, OneNote) carries its own
 * copy with only the app name and required scope differing.
 *
 * Features beyond the original Outlook graph-client:
 *   1. Refreshed tokens are persisted via `updateUserSecrets` callback.
 *   2. Throttled (429) and transient (503, 504) responses are retried with
 *      Retry-After + exponential backoff, respecting idempotency.
 *   3. Responses can be decoded as json, text, buffer, or handed back raw.
 *   4. Raw request bodies (rawBody) sent as-is for multipart/form-data.
 *   5. A mid-flight 401 triggers exactly one token refresh and replay before
 *      surfacing the "reconnect your account" message.
 *   6. Error messages surface innerError.request-id and truncate HTML bodies.
 */

import type { GraphError, GraphSecrets } from './types'

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0'
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
const REQUEST_TIMEOUT_MS = 30_000
const MAX_ATTEMPTS = 3
const RETRYABLE_STATUS = new Set([429, 503, 504])
/** Upper bound on an honored Retry-After, so a large server-advertised delay cannot hang a request. */
const MAX_RETRY_DELAY_MS = 10_000
/** Cap on how much of a non-JSON error body is embedded in the message (Azure Front Door returns full HTML). */
const MAX_ERROR_BODY_CHARS = 2048

/**
 * Surfaced when a 401 survives a token refresh.
 * Distinct from the generic Graph error so the agent can tell "reconnect the
 * account" apart from other auth failures.
 */
const RECONNECT_MESSAGE =
  'Microsoft rejected the access token and refreshing it did not help. ' +
  'The refresh token is no longer valid — please reconnect your Microsoft account.'

/**
 * Only these methods may be retried after a response was received.
 * Retrying a POST that already reached Graph can create a duplicate.
 */
function isIdempotent(method: string): boolean {
  const m = method.toUpperCase()
  return m === 'GET' || m === 'PUT' || m === 'PATCH' || m === 'DELETE'
}

/** Exponential backoff used when no (or no usable) Retry-After is present. */
function backoffMs(attempt: number): number {
  return 2 ** attempt * 500
}

/** Milliseconds to wait before the next attempt. */
function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after')
  if (header !== null && header.trim() !== '') {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS)
    }
  }
  return backoffMs(attempt)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface GraphRequestOptions {
  /** Extra request headers, merged over the defaults. */
  headers?: Record<string, string>
  /** How to decode a successful response body. Defaults to 'json'. */
  responseType?: 'json' | 'text' | 'buffer' | 'raw'
  /** Raw body bytes, sent as-is instead of JSON-serializing `body`. */
  rawBody?: Buffer
  /**
   * Omit the Authorization header for this request. Needed for pre-authenticated
   * URLs Graph itself hands back (e.g. a copy-operation monitor URL).
   */
  skipAuth?: boolean
}

function getDisplayName(email?: string): string | undefined {
  if (!email) return undefined
  const localPart = email.split('@')[0]
  return localPart
    .split(/[._-]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

/**
 * Creates an authenticated Graph API client from secrets.
 *
 * @param secrets        Merged system + user secrets (GraphSecrets)
 * @param updateUserSecrets  Optional callback to persist refreshed tokens
 * @param appName        App name for error messages (e.g. "OneDrive", "Excel")
 * @param requiredScope  The primary Graph scope for 403 error messages
 *
 * Refreshes the access token when it is expired or within 60s of expiring,
 * and persists the new credentials so the next call does not refresh again.
 */
export async function createGraphClient(
  secrets: GraphSecrets,
  updateUserSecrets?: (secrets: Record<string, string>) => Promise<void>,
  appName = 'Microsoft',
  requiredScope?: string,
) {
  const clientId = secrets.CLIENT_ID
  const clientSecret = secrets.CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error(
      `Microsoft OAuth credentials not configured. Missing CLIENT_ID or CLIENT_SECRET.`,
    )
  }

  let accessToken = secrets.ACCESS_TOKEN
  let refreshToken = secrets.REFRESH_TOKEN
  const expiryDate = secrets.EXPIRY_DATE ? new Date(secrets.EXPIRY_DATE).getTime() : undefined

  if (!accessToken || !refreshToken) {
    throw new Error(`${appName} account not connected. Please connect your Microsoft account.`)
  }

  /**
   * Exchanges the refresh token for a fresh access token and persists it.
   * Shared by the proactive refresh (driven by EXPIRY_DATE) and the reactive
   * one a mid-flight 401 triggers.
   */
  async function refreshAccessToken(): Promise<void> {
    if (!refreshToken) {
      throw new Error(`${appName} account not connected. Please connect your Microsoft account.`)
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const tokenResponse = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (!tokenResponse.ok) {
        // The refresh token is dead: expired after ~90 days idle, or revoked.
        throw new Error(
          'Microsoft refresh token is no longer valid. Please reconnect your account.',
        )
      }

      const tokens = (await tokenResponse.json()) as Record<string, unknown>
      if (typeof tokens.access_token !== 'string' || !tokens.access_token) {
        throw new Error(
          'Microsoft token refresh returned no access token. Please reconnect your account.',
        )
      }
      accessToken = tokens.access_token
      if (tokens.refresh_token) refreshToken = tokens.refresh_token as string

      // Persist the new credentials so the next call skips refresh.
      const expiresInSec = typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600
      if (updateUserSecrets) {
        try {
          await updateUserSecrets({
            ACCESS_TOKEN: accessToken,
            REFRESH_TOKEN: refreshToken as string,
            EXPIRY_DATE: new Date(Date.now() + expiresInSec * 1000).toISOString(),
          })
        } catch (persistError) {
          console.warn(`[${appName}] Failed to persist refreshed token:`, persistError)
        }
      }
    } catch (error: unknown) {
      clearTimeout(timeoutId)
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to refresh Microsoft token: ${message}`)
    }
  }

  // Proactive refresh: if token is expired or about to expire (within 60s)
  const needsRefresh = !expiryDate || expiryDate < Date.now() + 60_000
  if (needsRefresh) {
    await refreshAccessToken()
  }

  // Resolve email: use stored secret or fetch from Graph API as fallback
  let email = secrets.EMAIL
  if (!email) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const meResponse = await fetch(`${GRAPH_BASE_URL}/me?$select=mail,userPrincipalName`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      })
      clearTimeout(timeoutId)
      if (meResponse.ok) {
        const me = (await meResponse.json()) as Record<string, unknown>
        email = (me.mail as string) || (me.userPrincipalName as string) || 'unknown'
      } else {
        email = 'unknown'
      }
    } catch {
      clearTimeout(timeoutId)
      email = 'unknown'
    }
  }

  async function graphRequest<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    options?: GraphRequestOptions,
  ): Promise<T> {
    const url = path.startsWith('http') ? path : `${GRAPH_BASE_URL}${path}`
    let headers: Record<string, string> = {
      ...(options?.skipAuth ? {} : { Authorization: `Bearer ${accessToken}` }),
      'Content-Type': 'application/json',
      ...options?.headers,
    }

    let lastError: unknown
    /** At most one refresh-and-replay per call, so a 401 loop cannot form. */
    let unauthorizedRetryUsed = false

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      let responseReceived = false

      const init: RequestInit = { method, headers, signal: controller.signal }
      if (options?.rawBody !== undefined) {
        init.body = options.rawBody as unknown as RequestInit['body']
      } else if (body !== undefined && method !== 'GET') {
        init.body = JSON.stringify(body)
      }

      try {
        const response = await fetch(url, init)
        responseReceived = true
        clearTimeout(timeoutId)

        // Throttling / transient errors: retry with backoff if idempotent
        if (RETRYABLE_STATUS.has(response.status) && isIdempotent(method)) {
          lastError = await buildGraphError(response, requiredScope)
          if (attempt < MAX_ATTEMPTS - 1) {
            await sleep(retryDelayMs(response, attempt))
            continue
          }
          throw lastError
        }

        // Reactive 401: refresh once and replay (outside idempotency rule —
        // a 401 means Graph rejected at the auth layer, before processing)
        if (response.status === 401 && !options?.skipAuth) {
          if (unauthorizedRetryUsed) throw new Error(RECONNECT_MESSAGE)
          unauthorizedRetryUsed = true
          lastError = new Error(RECONNECT_MESSAGE)

          try {
            await refreshAccessToken()
          } catch {
            throw new Error(RECONNECT_MESSAGE)
          }

          headers = { ...headers, Authorization: `Bearer ${accessToken}` }

          if (attempt < MAX_ATTEMPTS - 1) continue
          throw lastError
        }

        // 'raw' returns the Response object itself — caller owns status handling
        if (options?.responseType === 'raw') return response as T

        if (response.status === 204) return null as T
        if (!response.ok) throw await buildGraphError(response, requiredScope)

        if (options?.responseType === 'buffer') {
          return Buffer.from(await response.arrayBuffer()) as T
        }
        if (options?.responseType === 'text') {
          return (await response.text()) as T
        }

        const contentType = response.headers.get('content-type') || ''
        if (contentType.includes('application/json')) {
          return (await response.json()) as T
        }
        return (await response.text()) as T
      } catch (error) {
        clearTimeout(timeoutId)

        // Connection-level failure (no response received) → safe to retry any method.
        // Abort (timeout) → only retry idempotent methods (may have reached Graph).
        const isAbort = error instanceof Error && error.name === 'AbortError'
        const isConnectionFailure = !responseReceived && error instanceof TypeError
        const retriable = isConnectionFailure || (isAbort && isIdempotent(method))

        if (retriable && attempt < MAX_ATTEMPTS - 1) {
          lastError = error
          await sleep(backoffMs(attempt))
          continue
        }
        throw error
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Graph request failed')
  }

  return { graphRequest, email, displayName: getDisplayName(email) }
}

/**
 * Converts a failed Graph response into an Error.
 * Surfaces innerError.request-id — the first thing Microsoft support asks for.
 * Never includes the Authorization header or any token value.
 */
export async function buildGraphError(
  response: Response,
  requiredScope?: string,
): Promise<Error> {
  const errorBody = await response.text()
  let code: string | undefined
  let message = `Graph API error (${response.status}): ${truncateErrorBody(errorBody)}`
  try {
    const parsed = JSON.parse(errorBody) as GraphError
    code = parsed.error?.code
    if (parsed.error?.message) {
      const requestId = parsed.error.innerError?.['request-id']
      message =
        `Graph API error: ${parsed.error.message} (${parsed.error.code})` +
        (requestId ? ` [request-id: ${requestId}]` : '')
    }
  } catch {
    // Body was not JSON; keep the raw (truncated) message.
  }

  // Name the scope on accessDenied 403s so the agent knows what's missing
  if (response.status === 403 && code === 'accessDenied' && requiredScope) {
    message += ` — the account is authenticated but lacks the required ${requiredScope} scope. Reconnect to grant it.`
  }

  return new Error(message)
}

/** Keeps an HTML interstitial or other oversized non-JSON body from flooding the message. */
function truncateErrorBody(body: string): string {
  if (body.length <= MAX_ERROR_BODY_CHARS) return body
  return `${body.slice(0, MAX_ERROR_BODY_CHARS)}… [truncated, ${body.length} characters total]`
}
