/**
 * Holded API Client
 *
 * Minimal HTTP client for Holded REST API with API key auth.
 * Base URL: https://api.holded.com/api/
 * Auth header: key: <HOLDED_API_KEY>
 */

import type { ToolContext } from '@teros/mca-sdk';

// =============================================================================
// TYPES
// =============================================================================

export interface HoldedSecrets {
  HOLDED_API_KEY?: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const BASE_URL = 'https://api.holded.com/api';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const RATE_LIMIT_STATUS = 429;

let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 200; // conservative: 5 req/s

// =============================================================================
// UTILITIES
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function respectRateLimit(): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL_MS) {
    await sleep(MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest);
  }
  lastRequestTime = Date.now();
}

function getRetryDelay(attempt: number, retryAfter?: number): number {
  if (retryAfter && retryAfter > 0) {
    return retryAfter * 1000;
  }
  return BASE_DELAY_MS * Math.pow(2, attempt); // 1s, 2s, 4s
}

// =============================================================================
// CLIENT
// =============================================================================

export async function holdedRequest(
  context: ToolContext,
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    params?: Record<string, string | number | boolean | undefined>;
    skipRateLimit?: boolean;
  } = {},
): Promise<unknown> {
  const userSecrets = (await context.getUserSecrets()) as HoldedSecrets;
  const apiKey = userSecrets.HOLDED_API_KEY;

  if (!apiKey) {
    throw new Error(
      'Holded API key not configured. Please set your HOLDED_API_KEY in the app settings.',
    );
  }

  const { method = 'GET', body, params, skipRateLimit = false } = options;

  let url = `${BASE_URL}${path}`;

  if (params) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    }
    const qs = searchParams.toString();
    if (qs) url += `?${qs}`;
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (!skipRateLimit) {
        await respectRateLimit();
      }

      const response = await fetch(url, {
        method,
        headers: {
          key: apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      // Handle rate limiting (429)
      if (response.status === RATE_LIMIT_STATUS) {
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;

        if (attempt < MAX_RETRIES) {
          const delay = getRetryDelay(attempt, retryAfter);
          await sleep(delay);
          continue;
        }
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(
          `Holded API rate limit exceeded after ${MAX_RETRIES} retries: ${errorText}`,
        );
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        let errorMessage: string;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.message || errorJson.error || errorText;
        } catch {
          errorMessage = errorText;
        }

        // Retry on 5xx errors
        if (response.status >= 500 && attempt < MAX_RETRIES) {
          const delay = getRetryDelay(attempt);
          await sleep(delay);
          continue;
        }

        throw new Error(`Holded API error ${response.status}: ${errorMessage}`);
      }

      if (response.status === 204) return { success: true };

      return response.json();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt >= MAX_RETRIES) {
        break;
      }

      if (lastError.message.includes('fetch') || lastError.message.includes('network')) {
        const delay = getRetryDelay(attempt);
        await sleep(delay);
        continue;
      }

      break;
    }
  }

  throw lastError || new Error('Holded API request failed after retries');
}

/**
 * Validate Holded credentials by making a lightweight API call.
 */
export async function validateCredentials(context: ToolContext): Promise<void> {
  await holdedRequest(context, '/invoicing/v1/contacts', {
    params: { limit: 1 },
    skipRateLimit: true,
  });
}
