/**
 * Canva API Client Manager
 *
 * Manages OAuth2 authentication and API requests for Canva Connect API.
 */

import type { HttpToolContext as ToolContext } from '@teros/mca-sdk';

// =============================================================================
// CONSTANTS
// =============================================================================

const CANVA_API_BASE = 'https://api.canva.com/rest/v1';

// =============================================================================
// TYPES
// =============================================================================

export interface CanvaRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: any;
  headers?: Record<string, string>;
}

// =============================================================================
// SINGLETON STATE
// =============================================================================

let cachedSystemSecrets: Record<string, string> | null = null;
let cachedUserSecrets: Record<string, string> | null = null;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function getAccessToken(): string | null {
  return cachedUserSecrets?.ACCESS_TOKEN || cachedUserSecrets?.access_token || null;
}

function getRefreshToken(): string | null {
  return cachedUserSecrets?.REFRESH_TOKEN || cachedUserSecrets?.refresh_token || null;
}

function getClientId(): string | null {
  return cachedSystemSecrets?.CLIENT_ID || cachedSystemSecrets?.client_id || null;
}

function getClientSecret(): string | null {
  return cachedSystemSecrets?.CLIENT_SECRET || cachedSystemSecrets?.client_secret || null;
}

// =============================================================================
// CLIENT INITIALIZATION
// =============================================================================

/**
 * Initialize Canva client with credentials from context
 */
export async function initializeCanvaClient(context: ToolContext): Promise<void> {
  // Get secrets from context
  const systemSecrets = await context.getSystemSecrets();
  const userSecrets = await context.getUserSecrets();

  // Cache secrets
  cachedSystemSecrets = systemSecrets;
  cachedUserSecrets = userSecrets;
}

/**
 * Ensure user is authenticated
 */
export async function ensureAuthenticated(context: ToolContext): Promise<string> {
  await initializeCanvaClient(context);

  const accessToken = getAccessToken();
  if (!accessToken) {
    throw new Error('Canva authentication required. Please connect your Canva account.');
  }

  return accessToken;
}

/**
 * Refresh the access token using the refresh token
 */
async function refreshAccessToken(): Promise<string> {
  const clientId = getClientId();
  const clientSecret = getClientSecret();
  const refreshToken = getRefreshToken();

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing credentials for token refresh');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch(`${CANVA_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to refresh token: ${error}`);
  }

  const data = await response.json();

  // Update cached secrets
  if (cachedUserSecrets) {
    cachedUserSecrets.ACCESS_TOKEN = data.access_token;
    if (data.refresh_token) {
      cachedUserSecrets.REFRESH_TOKEN = data.refresh_token;
    }
  }

  console.error('✅ Canva token refreshed successfully');
  return data.access_token;
}

// =============================================================================
// API REQUEST HELPER
// =============================================================================

/**
 * Make an authenticated request to the Canva API
 */
export async function canvaRequest<T = any>(
  context: ToolContext,
  endpoint: string,
  options: CanvaRequestOptions = {},
): Promise<T> {
  let accessToken = await ensureAuthenticated(context);

  const makeRequest = async (token: string) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...options.headers,
    };

    if (options.body && !options.headers?.['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(`${CANVA_API_BASE}${endpoint}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    return response;
  };

  let response = await makeRequest(accessToken);

  // If unauthorized, try refreshing the token
  if (response.status === 401) {
    try {
      accessToken = await refreshAccessToken();
      response = await makeRequest(accessToken);
    } catch (refreshError) {
      throw new Error('Authentication expired. Please reconnect your Canva account.');
    }
  }

  if (!response.ok) {
    const errorText = await response.text();
    let errorMessage: string;
    try {
      const errorJson = JSON.parse(errorText);
      errorMessage = errorJson.message || errorJson.error_description || errorText;
    } catch {
      errorMessage = errorText;
    }
    throw new Error(`Canva API error (${response.status}): ${errorMessage}`);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return {} as T;
  }

  return response.json();
}

/**
 * Wrapper that handles 401 errors by attempting token refresh
 */
export async function withAuthRetry<T>(
  context: ToolContext,
  operation: () => Promise<T>,
  operationName: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error: any) {
    // Check if it's a 401 error
    const is401 =
      error?.code === 401 ||
      error?.status === 401 ||
      error?.message?.includes('401') ||
      error?.message?.toLowerCase().includes('authentication');

    if (!is401) {
      throw error;
    }

    console.error(`[CanvaClient] 401 error in ${operationName}, attempting token refresh...`);

    // Try to refresh and retry
    try {
      await refreshAccessToken();
      return await operation();
    } catch (refreshError) {
      throw new Error('Authentication expired. Please reconnect your Canva account.');
    }
  }
}

/**
 * Get cached secrets for health check
 */
export function getCachedSecrets(): {
  system: Record<string, string> | null;
  user: Record<string, string> | null;
} {
  return {
    system: cachedSystemSecrets,
    user: cachedUserSecrets,
  };
}
