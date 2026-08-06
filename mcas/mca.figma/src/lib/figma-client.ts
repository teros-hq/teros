/**
 * Figma API Client
 *
 * HTTP client for the Figma REST API with OAuth2 token refresh on 401.
 * Secrets are pulled lazily from the tool context on every request so that
 * a credential update from the backend (re-OAuth) takes effect immediately
 * without restarting the MCA.
 */

import type { ToolContext } from "@teros/mca-sdk"
import { classifyFigmaError, FigmaApiError } from "./figma-error"

export const FIGMA_API_BASE = "https://api.figma.com/v1"
export const FIGMA_TOKEN_URL = "https://api.figma.com/v1/oauth/token"

export interface FigmaSecrets {
  CLIENT_ID?: string
  CLIENT_SECRET?: string
  ACCESS_TOKEN?: string
  REFRESH_TOKEN?: string
  EXPIRY_DATE?: string
}

export async function loadFigmaSecrets(context: ToolContext): Promise<FigmaSecrets> {
  const [systemSecrets, userSecrets] = await Promise.all([
    context.getSystemSecrets(),
    context.getUserSecrets(),
  ])
  return { ...systemSecrets, ...userSecrets } as FigmaSecrets
}

async function refreshAccessToken(secrets: FigmaSecrets): Promise<string> {
  const { CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN } = secrets

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new FigmaApiError(
      "SYSTEM_CONFIG_MISSING",
      "Figma OAuth CLIENT_ID and CLIENT_SECRET not configured (system secrets).",
      {
        type: "admin_action",
        description: "Configure CLIENT_ID and CLIENT_SECRET in system secrets.",
      },
    )
  }
  if (!REFRESH_TOKEN) {
    throw new FigmaApiError(
      "AUTH_REQUIRED",
      "No refresh token available. Please reconnect your Figma account.",
      { type: "user_action", description: "Reconnect Figma in app settings." },
    )
  }

  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")

  const response = await fetch(FIGMA_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw classifyFigmaError(response.status, body, "POST", "/oauth/token")
  }

  const data = (await response.json()) as { access_token: string }
  return data.access_token
}

export interface FigmaRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE"
  body?: unknown
}

// Retry policy: only safe-to-retry methods (GET) and only transient statuses.
// Mutations (POST/PUT/DELETE) skip retry to avoid duplicates without
// idempotency keys.
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504])
const MAX_RETRIES = 3
const RETRY_DELAYS_MS = [800, 2000, 5000] // exponential-ish, jittered below

function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * 400)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Make an authenticated request to the Figma API.
 *
 * Behaviour:
 * - Refreshes the access token once on 401 and retries before surfacing.
 * - For idempotent reads (`GET`), retries up to {@link MAX_RETRIES} times on
 *   transient errors (429 rate-limit, 5xx) with exponential backoff +
 *   jitter (~0.8s, ~2s, ~5s). Honours `Retry-After` header on 429 when
 *   present (clamped to 30s to avoid hangs).
 * - Mutations (POST/PUT/DELETE) skip retry — the caller must handle
 *   idempotency at a higher layer if needed.
 */
export async function figmaRequest<T>(
  endpoint: string,
  context: ToolContext,
  options: FigmaRequestOptions = {},
): Promise<T> {
  const method = options.method ?? "GET"
  const secrets = await loadFigmaSecrets(context)

  const token = secrets.ACCESS_TOKEN
  if (!token) {
    throw new FigmaApiError(
      "AUTH_REQUIRED",
      "Figma account not connected. Please connect your Figma account.",
      { type: "user_action", description: "Connect your Figma account in app settings." },
    )
  }

  const url = `${FIGMA_API_BASE}${endpoint}`
  const requestInit = (accessToken: string): RequestInit => ({
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  let activeToken = token
  let attempt = 0

  while (true) {
    let response = await fetch(url, requestInit(activeToken))

    // Token refresh once on 401 (independent of the retry loop).
    if (response.status === 401 && attempt === 0) {
      activeToken = await refreshAccessToken(secrets)
      response = await fetch(url, requestInit(activeToken))
    }

    if (response.ok) {
      if (response.status === 204) return undefined as T
      return response.json() as Promise<T>
    }

    const shouldRetry =
      method === "GET" && attempt < MAX_RETRIES && RETRY_STATUSES.has(response.status)

    if (!shouldRetry) {
      const body = await response.text()
      throw classifyFigmaError(response.status, body, method, endpoint)
    }

    // Respect Retry-After if present (in seconds; clamped to 30s).
    const retryAfterHeader = response.headers.get("retry-after")
    const retryAfterMs = retryAfterHeader
      ? Math.min(30_000, Number.parseInt(retryAfterHeader, 10) * 1000)
      : (RETRY_DELAYS_MS[attempt] ?? 5000)
    await sleep(jitter(retryAfterMs))
    attempt++
  }
}
