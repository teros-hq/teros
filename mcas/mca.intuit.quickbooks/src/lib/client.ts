/**
 * QuickBooks Online API client — token management and HTTP request helper.
 *
 * Extracted from src/index.ts to enable unit testing without starting
 * the MCA server.
 */

import type { ToolContext } from '@teros/mca-sdk';

// =============================================================================
// CONSTANTS
// =============================================================================

export const PRODUCTION_BASE_URL = 'https://quickbooks.api.intuit.com/v3/company';
export const SANDBOX_BASE_URL = 'https://sandbox-quickbooks.api.intuit.com/v3/company';
export const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

/** Refresh when less than this many ms remain on the access token. */
export const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

/** Backoff delay for 429 rate-limit retry (1 second). */
export const RATE_LIMIT_BACKOFF_MS = 1000;

// =============================================================================
// TYPES
// =============================================================================

export interface QuickBooksUserSecrets {
  ACCESS_TOKEN?: string;
  REFRESH_TOKEN?: string;
  REALM_ID?: string;
  EXPIRY_DATE?: string;
}

export interface QuickBooksSystemSecrets {
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
  QUICKBOOKS_USE_SANDBOX?: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  x_refresh_token_expires_in?: number;
}

// =============================================================================
// HELPERS
// =============================================================================

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns the API base URL — sandbox if QUICKBOOKS_USE_SANDBOX is set to "true"
 * in system secrets, production otherwise.
 */
export function getBaseUrl(systemSecrets: QuickBooksSystemSecrets): string {
  if (systemSecrets.QUICKBOOKS_USE_SANDBOX?.toLowerCase() === 'true') {
    return SANDBOX_BASE_URL;
  }
  return PRODUCTION_BASE_URL;
}

/**
 * Build the Basic auth header for token requests.
 * Intuit expects: Authorization: Basic base64(client_id:client_secret)
 */
export function buildBasicAuthHeader(clientId: string, clientSecret: string): string {
  const credentials = btoa(`${clientId}:${clientSecret}`);
  return `Basic ${credentials}`;
}

// =============================================================================
// TOKEN MANAGEMENT
// =============================================================================

/**
 * Refresh the access token using the stored refresh token.
 *
 * Posts to the Intuit token endpoint with:
 * - Authorization: Basic base64(client_id:client_secret)
 * - Body: grant_type=refresh_token&refresh_token={refresh_token}
 *
 * Persists the new access_token, refresh_token (if returned), and expiry
 * timestamp via context.updateUserSecrets().
 *
 * @returns The new access token.
 * @throws If system secrets are missing, the refresh call fails, or the
 *         response does not contain an access token.
 */
export async function refreshAccessToken(context: ToolContext): Promise<string> {
  const systemSecrets = (await context.getSystemSecrets()) as QuickBooksSystemSecrets;
  const clientId = systemSecrets.CLIENT_ID;
  const clientSecret = systemSecrets.CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'QuickBooks OAuth client credentials not configured. Please set CLIENT_ID and CLIENT_SECRET as system secrets.',
    );
  }

  const userSecrets = (await context.getUserSecrets()) as QuickBooksUserSecrets;
  const refreshToken = userSecrets.REFRESH_TOKEN;

  if (!refreshToken) {
    throw new Error(
      'QuickBooks account not connected. Please connect your QuickBooks account via OAuth.',
    );
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: buildBasicAuthHeader(clientId, clientSecret),
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(
      `QuickBooks token refresh failed (${response.status}): ${errorText}. Please reconnect your QuickBooks account.`,
    );
  }

  const data = (await response.json()) as TokenResponse;

  if (!data.access_token) {
    throw new Error(
      'QuickBooks token refresh returned no access token. Please reconnect your account.',
    );
  }

  // Persist the new tokens so the next call skips refresh.
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  const secretsToUpdate: Record<string, string> = {
    ACCESS_TOKEN: data.access_token,
    EXPIRY_DATE: expiresAt,
  };

  // Intuit may return a new refresh token — store it if present.
  if (data.refresh_token) {
    secretsToUpdate.REFRESH_TOKEN = data.refresh_token;
  }

  try {
    await context.updateUserSecrets(secretsToUpdate);
  } catch (persistError) {
    console.warn('[QuickBooks] Failed to persist refreshed token:', persistError);
  }

  return data.access_token;
}

/**
 * Returns a valid access token, refreshing it automatically if it is expired
 * or about to expire (within TOKEN_REFRESH_BUFFER_MS).
 *
 * 1. Reads access_token and expiry_date from user secrets.
 * 2. If the token has >5 min remaining, returns it immediately.
 * 3. Otherwise, calls refreshAccessToken() to get a new one.
 *
 * @returns A valid OAuth 2.0 access token.
 * @throws If no refresh token is available or the refresh fails.
 */
export async function getValidAccessToken(context: ToolContext): Promise<string> {
  const userSecrets = (await context.getUserSecrets()) as QuickBooksUserSecrets;

  const accessToken = userSecrets.ACCESS_TOKEN;
  const expiryDateStr = userSecrets.EXPIRY_DATE;

  // If we have a token and it's still valid (with buffer), return it.
  if (accessToken && expiryDateStr) {
    const expiryMs = new Date(expiryDateStr).getTime();
    const nowMs = Date.now();

    if (expiryMs - nowMs > TOKEN_REFRESH_BUFFER_MS) {
      return accessToken;
    }
  }

  // Token is missing or about to expire — refresh.
  return refreshAccessToken(context);
}

// =============================================================================
// API CLIENT
// =============================================================================

/**
 * Make an authenticated request to the QuickBooks Online API.
 *
 * 1. Obtains a valid access token via getValidAccessToken().
 * 2. Reads realmId from user secrets.
 * 3. Sends the request to {baseUrl}/{realmId}/{path} with auth headers.
 * 4. Handles 401 (token expired) with one automatic refresh + retry.
 * 5. Handles 429 (rate limit) with exponential backoff (1 retry).
 *
 * @param path     API path after the realmId segment (e.g. "query?query=SELECT ...").
 * @param context  Tool context for secret access.
 * @param method   HTTP method (default GET).
 * @param body     Request body for POST/PUT/PATCH (optional).
 * @returns        The parsed JSON response.
 * @throws         On auth failure, rate limit exhaustion, or API errors.
 */
export async function quickbooksRequest(
  path: string,
  context: ToolContext,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET',
  body?: unknown,
): Promise<unknown> {
  const systemSecrets = (await context.getSystemSecrets()) as QuickBooksSystemSecrets;
  const baseUrl = getBaseUrl(systemSecrets);

  const userSecrets = (await context.getUserSecrets()) as QuickBooksUserSecrets;
  const realmId = userSecrets.REALM_ID;

  if (!realmId) {
    throw new Error(
      'QuickBooks company ID (realmId) not configured. Please connect your QuickBooks account via OAuth.',
    );
  }

  let token = await getValidAccessToken(context);

  const url = `${baseUrl}/${realmId}/${path}`;

  let refreshedOnce = false;
  let retriedRateLimit = false;

  for (let attempt = 0; attempt < 3; attempt++) {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    };

    if (body !== undefined && method !== 'GET') {
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);

    // --- 401: token expired — refresh once and retry ---
    if (response.status === 401 && !refreshedOnce) {
      refreshedOnce = true;
      try {
        token = await refreshAccessToken(context);
      } catch (refreshError) {
        throw new Error(
          `QuickBooks authentication failed: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`,
        );
      }
      continue;
    }

    // --- 429: rate limited — backoff once and retry ---
    if (response.status === 429 && !retriedRateLimit) {
      retriedRateLimit = true;
      const retryAfterHeader = response.headers.get('Retry-After');
      const delay = retryAfterHeader
        ? parseInt(retryAfterHeader, 10) * 1000
        : RATE_LIMIT_BACKOFF_MS * Math.pow(2, attempt);
      await sleep(delay);
      continue;
    }

    // --- Other errors ---
    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      let errorMessage: string;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage =
          errorJson?.Fault?.Error?.[0]?.Message ||
          errorJson?.error ||
          errorJson?.message ||
          errorText;
      } catch {
        errorMessage = errorText;
      }

      if (response.status === 401) {
        throw new Error(
          `QuickBooks authentication failed after token refresh: ${errorMessage}. Please reconnect your QuickBooks account.`,
        );
      }

      throw new Error(`QuickBooks API error ${response.status}: ${errorMessage}`);
    }

    // --- Success ---
    if (response.status === 204) return { success: true };
    return response.json();
  }

  throw new Error('QuickBooks API request failed after retries');
}
