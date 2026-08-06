import type { ToolContext } from '@teros/mca-sdk';

export interface ZendeskSecrets {
  SUBDOMAIN?: string;
  EMAIL?: string;
  API_TOKEN?: string;
}

// Rate limiter state
const requestTimestamps: number[] = [];
const RATE_LIMIT_PER_MINUTE = 600; // Conservative default (below Essential plan 700)
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Build the base URL for a Zendesk instance from the subdomain.
 */
export function getBaseUrl(subdomain: string): string {
  return `https://${subdomain}.zendesk.com/api/v2`;
}

/**
 * Encode credentials for Basic Auth (email/token:apiToken).
 */
export function encodeAuth(email: string, apiToken: string): string {
  return btoa(`${email}/token:${apiToken}`);
}

/**
 * Enforce rate limiting by tracking request timestamps.
 * Waits if we are approaching the limit.
 */
async function enforceRateLimit(): Promise<void> {
  const now = Date.now();
  // Remove timestamps outside the window
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - RATE_LIMIT_WINDOW_MS) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= RATE_LIMIT_PER_MINUTE) {
    const oldest = requestTimestamps[0];
    const waitMs = oldest + RATE_LIMIT_WINDOW_MS - now + 100; // +100ms buffer
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    // Recurse to double-check after waiting
    return enforceRateLimit();
  }
  requestTimestamps.push(now);
}

/**
 * Make an authenticated request to the Zendesk REST API.
 * Includes rate limiting and robust error handling.
 */
export async function zendeskRequest(
  context: ToolContext,
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    query?: Record<string, string | number | undefined>;
  } = {},
): Promise<unknown> {
  const userSecrets = (await context.getUserSecrets()) as ZendeskSecrets;
  const subdomain = userSecrets.SUBDOMAIN;
  const email = userSecrets.EMAIL;
  const apiToken = userSecrets.API_TOKEN;

  if (!subdomain || !email || !apiToken) {
    throw new Error(
      'Zendesk credentials not configured. Please set SUBDOMAIN, EMAIL, and API_TOKEN in app settings.',
    );
  }

  const { method = 'GET', body, query } = options;

  // Build URL with query params
  const url = new URL(`${getBaseUrl(subdomain)}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  // Enforce rate limit before request
  await enforceRateLimit();

  const headers: Record<string, string> = {
    Authorization: `Basic ${encodeAuth(email, apiToken)}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  const response = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);

    // Handle specific Zendesk error codes
    if (response.status === 429) {
      throw new Error(
        `Zendesk API rate limit exceeded (429). Please wait before retrying. Details: ${errorText}`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Zendesk authentication failed (${response.status}): ${errorText}`,
      );
    }
    if (response.status === 404) {
      throw new Error(
        `Zendesk resource not found (${response.status}): ${errorText}`,
      );
    }
    if (response.status === 422) {
      throw new Error(
        `Zendesk validation error (${response.status}): ${errorText}`,
      );
    }

    throw new Error(`Zendesk API error ${response.status}: ${errorText}`);
  }

  // 204 No Content
  if (response.status === 204) return { success: true };

  return response.json();
}

/**
 * Validate Zendesk credentials by making a real API call.
 */
export async function validateCredentials(context: ToolContext): Promise<void> {
  await zendeskRequest(context, '/users/me.json');
}
